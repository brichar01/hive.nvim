import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import {
  detectSupportedImageMimeTypeFromFile,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { NvimConnection } from "./nvim_wrapper.ts";

/** Pi's file operations. Reads come from a buffer when one holds the path, and from disk otherwise. Writes always go to a buffer. */
export interface NvimOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
}

export function createNvimOperations(nvim: NvimConnection): NvimOperations {
  const loaded = async (path: string): Promise<boolean> =>
    (await nvim.exec("return require('hive.fs').loaded(...)", [path])) === true;

  const read = async (path: string): Promise<Buffer> => {
    const content = await nvim.exec("return require('hive.fs').read(...)", [
      path,
    ]);
    return typeof content === "string"
      ? Buffer.from(content, "utf-8")
      : readFile(path);
  };

  const write = async (path: string, content: string): Promise<void> => {
    await nvim.exec("require('hive.fs').write(...)", [path, content]);
  };

  // A buffer with no file on disk yet is never an image.
  const detectImage = (path: string): Promise<string | null | undefined> =>
    detectSupportedImageMimeTypeFromFile(path).catch(() => null);

  const accessible =
    (mode: number) =>
    async (path: string): Promise<void> => {
      if (!(await loaded(path))) {
        await access(path, mode);
      }
    };

  return {
    read: {
      // Image detection sniffs the file on disk, so an image is never served from a buffer.
      readFile: async (path) =>
        (await detectImage(path)) ? readFile(path) : read(path),
      access: accessible(constants.R_OK),
      detectImageMimeType: detectImage,
    },
    write: {
      writeFile: write,
      mkdir: async (dir) => {
        await mkdir(dir, { recursive: true });
      },
    },
    edit: {
      readFile: read,
      writeFile: write,
      access: accessible(constants.R_OK | constants.W_OK),
    },
  };
}
