import type { JobArtifact, JobSpec, JobStatus } from "./contracts";

function sameContract(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface OwnedJob {
  spec: JobSpec;
  status: JobStatus;
  artifacts: Map<string, JobArtifact>;
}

/** Session-scoped ownership boundary for client-managed jobs and their artifacts. */
export class JobRegistry {
  private readonly sessions = new Map<string, Map<string, OwnedJob>>();

  add(sessionId: string, spec: JobSpec, status: JobStatus): void {
    const jobs = this.sessions.get(sessionId) ?? new Map<string, OwnedJob>();
    if (jobs.has(status.jobId)) throw new Error(`job '${status.jobId}' already exists in session`);
    jobs.set(status.jobId, {
      spec,
      status,
      artifacts: new Map(status.artifacts.map((artifact) => [artifact.artifactId, artifact])),
    });
    this.sessions.set(sessionId, jobs);
  }

  get(sessionId: string, jobId: string): OwnedJob | undefined {
    return this.sessions.get(sessionId)?.get(jobId);
  }

  update(sessionId: string, status: JobStatus): void {
    const job = this.get(sessionId, status.jobId);
    if (!job) throw new Error(`job '${status.jobId}' is not owned by this session`);
    if (job.spec.kind !== status.kind) throw new Error(`job '${status.jobId}' changed kind`);
    job.status = status;
    job.artifacts = new Map(status.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  }

  artifact(sessionId: string, jobId: string, artifactId: string): JobArtifact | undefined {
    return this.get(sessionId, jobId)?.artifacts.get(artifactId);
  }

  /** Validate immutable job ownership before restoring client-managed state after session/load. */
  validateRehydration(
    sessionId: string,
    jobs: Array<{ spec: JobSpec; status: JobStatus }>,
  ): Array<{ path: string; message: string }> {
    const current = this.sessions.get(sessionId);
    const issues: Array<{ path: string; message: string }> = [];
    for (const job of jobs) {
      const existing = current?.get(job.status.jobId);
      if (existing && !sameContract(existing.spec, job.spec)) {
        issues.push({
          path: `jobs.${job.status.jobId}.spec`,
          message: "a different job specification is already owned under this id",
        });
        continue;
      }
      if (existing) {
        for (const artifact of job.status.artifacts) {
          const priorArtifact = existing.artifacts.get(artifact.artifactId);
          if (priorArtifact && !sameContract(priorArtifact, artifact)) {
            issues.push({
              path: `jobs.${job.status.jobId}.artifacts.${artifact.artifactId}`,
              message: "a different artifact manifest is already owned under this id",
            });
          }
        }
      }
    }
    return issues;
  }

  /** Merge an already-validated client resume manifest into the session ownership boundary. */
  rehydrateSession(sessionId: string, jobs: Array<{ spec: JobSpec; status: JobStatus }>): void {
    const current = this.sessions.get(sessionId) ?? new Map<string, OwnedJob>();
    for (const job of jobs) {
      current.set(job.status.jobId, {
        spec: job.spec,
        status: job.status,
        artifacts: new Map(job.status.artifacts.map((artifact) => [artifact.artifactId, artifact])),
      });
    }
    if (jobs.length > 0) this.sessions.set(sessionId, current);
  }
}
