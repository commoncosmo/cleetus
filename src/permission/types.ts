export type Decision = "allow" | "deny" | "ask";

export interface PermissionRule {
  /** Tool name (optional; omitted for a pure pathPrefix directory rule). Trailing "*" = prefix. */
  tool?: string;
  /** Matched against the serialised args string (the caller's argsSummary); trailing "*" =
   *  startsWith, else exact. */
  argsPattern?: string;
  /** Absolute directory; matches a path-writing tool whose resolved target path is under it. */
  pathPrefix?: string;
  decision: Decision;
}

export interface PermissionRules {
  project: PermissionRule[];
  global: PermissionRule[];
}

export const BUILTIN_DEFAULTS: Record<string, Decision> = {
  read_file: "allow",
  glob: "allow",
  grep: "allow",
  code_search: "allow",
  remember: "allow",
  todo_write: "allow",
  todo_list_show: "allow",
  todo_list_write: "allow",
  todo_list_delete: "ask",
  todo_list_save: "ask",
  todo_list_load: "allow",
  write_file: "ask",
  save_fetched_json: "ask",
  edit_file: "ask",
  apply_patch: "ask",
  bash: "ask",
  smoke_run: "ask",
  git_status: "allow",
  git_diff: "allow",
  git_log: "allow",
  run_workflow: "allow",
  git_init: "ask",
  git_add: "ask",
  git_commit: "ask",
  git_push: "ask",
  create_pr: "ask",
  create_github_repo: "ask",
  task: "ask",
};

/** Tools that write to a target path — the set a `pathPrefix` rule governs. */
export const PATH_WRITING_TOOLS = new Set([
  "write_file",
  "save_fetched_json",
  "edit_file",
  "multi_edit",
  "apply_patch",
]);

/** Read tools whose resolved target a `pathPrefix` rule also governs (out-of-project read
 *  escalation, WS1). code_search is exempt: it queries the project vector index, not the FS. */
export const PATH_READING_TOOLS = new Set(["read_file", "glob", "grep"]);
