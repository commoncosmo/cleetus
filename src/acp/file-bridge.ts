import { readFile, writeFile } from "node:fs/promises";

export interface FileBridge {
  readTextFile(absPath: string): Promise<string>;
  writeTextFile(absPath: string, content: string): Promise<void>;
}

/** Default: operate directly on disk. Identical to the file tools' current behavior. */
export class DirectFileBridge implements FileBridge {
  readTextFile(absPath: string): Promise<string> {
    return readFile(absPath, "utf8");
  }
  async writeTextFile(absPath: string, content: string): Promise<void> {
    await writeFile(absPath, content);
  }
}

type RequestFn = (method: string, params: unknown) => Promise<unknown>;

/** Route file I/O through the ACP client so the editor's unsaved buffers are respected. Only
 *  constructed when the client advertised the matching fs capability. */
export class AcpFileBridge implements FileBridge {
  constructor(
    private readonly request: RequestFn,
    private readonly sessionId: string,
  ) {}

  async readTextFile(absPath: string): Promise<string> {
    const r = (await this.request("fs/read_text_file", {
      sessionId: this.sessionId,
      path: absPath,
    })) as { content: string };
    return r.content;
  }

  async writeTextFile(absPath: string, content: string): Promise<void> {
    await this.request("fs/write_text_file", {
      sessionId: this.sessionId,
      path: absPath,
      content,
    });
  }
}
