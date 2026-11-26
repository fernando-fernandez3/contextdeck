import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import Busboy from 'busboy';
import { PayloadTooLargeError, ValidationError } from '@contextdeck/core';

export interface ParsedMultipartUpload {
  fields: Record<string, string>;
  file?: {
    tmpPath: string;
    fileName: string;
    mimeType: string;
    bytesWritten: number;
  };
}

const MAX_FIELD_BYTES = 200 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 512 * 1024;

/**
 * Stream a multipart/form-data upload directly to a temp file inside `mediaDir`
 * using busboy, enforcing `maxMediaBytes` on the wire (never buffering the file in memory).
 * Cleans up the partial temp file on any size limit violation or stream error.
 */
export async function parseStreamingMultipartUpload(options: {
  request: Request;
  mediaDir: string;
  maxMediaBytes: number;
}): Promise<ParsedMultipartUpload> {
  const { request, mediaDir, maxMediaBytes } = options;
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new ValidationError('Expected multipart/form-data content type.');
  }

  // Fast reject if Content-Length is already clearly above limit
  const clHeader = request.headers.get('content-length');
  if (clHeader !== null && !request.headers.has('transfer-encoding')) {
    const cl = Number.parseInt(clHeader, 10);
    if (Number.isFinite(cl) && cl > maxMediaBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
      throw new PayloadTooLargeError(
        `Multipart upload exceeds maximum allowed size of ${maxMediaBytes} bytes.`,
      );
    }
  }

  if (!request.body) {
    throw new ValidationError('Empty multipart request body.');
  }

  await fsp.mkdir(mediaDir, { recursive: true });

  return new Promise<ParsedMultipartUpload>((resolve, reject) => {
    const fields: Record<string, string> = {};
    let fileResult: ParsedMultipartUpload['file'] | undefined;
    let fileWritePromise: Promise<void> | null = null;
    let activeTmpPath: string | null = null;
    let activeWriteStream: fs.WriteStream | null = null;
    let settled = false;
    let totalWireBytes = 0;

    const cleanupTemp = async () => {
      if (activeWriteStream) {
        activeWriteStream.destroy();
        activeWriteStream = null;
      }
      if (activeTmpPath) {
        const toDelete = activeTmpPath;
        activeTmpPath = null;
        await fsp.rm(toDelete, { force: true }).catch(() => {});
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      nodeStream.unpipe(busboy);
      setImmediate(() => {
        nodeStream.destroy();
        busboy.destroy();
      });
      void cleanupTemp().finally(() => reject(err));
    };

    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: {
        files: 1,
        fileSize: maxMediaBytes,
        fields: 50,
        fieldSize: MAX_FIELD_BYTES,
      },
    });

    busboy.on('field', (name, value, info) => {
      if (info.valueTruncated) {
        fail(new PayloadTooLargeError(`Form field "${name}" exceeds maximum field size.`));
        return;
      }
      fields[name] = value;
    });

    busboy.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'file') {
        stream.resume();
        return;
      }

      const tmpPath = path.join(mediaDir, `.tmp-upload-${crypto.randomBytes(8).toString('hex')}`);
      activeTmpPath = tmpPath;
      const ws = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o644 });
      activeWriteStream = ws;

      let fileBytes = 0;
      let hitLimit = false;

      fileWritePromise = new Promise<void>((resFile) => {
        stream.on('limit', () => {
          hitLimit = true;
          stream.unpipe(ws);
          stream.resume();
          const err = new PayloadTooLargeError(
            `Uploaded file exceeds maximum allowed size of ${maxMediaBytes} bytes.`,
          );
          fail(err);
          resFile();
        });

        stream.on('data', (chunk: Buffer) => {
          fileBytes += chunk.length;
          if (fileBytes > maxMediaBytes && !hitLimit) {
            hitLimit = true;
            stream.unpipe(ws);
            stream.resume();
            const err = new PayloadTooLargeError(
              `Uploaded file exceeds maximum allowed size of ${maxMediaBytes} bytes.`,
            );
            fail(err);
            resFile();
          }
        });

        ws.on('error', (err) => {
          fail(err);
          resFile();
        });

        ws.on('finish', async () => {
          if (hitLimit || settled) {
            resFile();
            return;
          }
          try {
            const fh = await fsp.open(tmpPath, 'r+');
            try {
              await fh.sync();
            } finally {
              await fh.close();
            }
            activeWriteStream = null;
            fileResult = {
              tmpPath,
              fileName: info.filename || 'upload.bin',
              mimeType: info.mimeType || 'application/octet-stream',
              bytesWritten: fileBytes,
            };
            resFile();
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
            resFile();
          }
        });

        stream.pipe(ws);
      });
    });

    busboy.on('filesLimit', () => {
      fail(new ValidationError('Only one file upload is allowed per request.'));
    });

    busboy.on('fieldsLimit', () => {
      fail(new ValidationError('Too many form fields in multipart upload.'));
    });

    busboy.on('error', (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    busboy.on('close', () => {
      if (settled) return;
      const done = fileWritePromise ?? Promise.resolve();
      done
        .then(() => {
          if (settled) return;
          settled = true;
          activeTmpPath = null; // ownership transferred to caller
          resolve({ fields, file: fileResult });
        })
        .catch((err) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        });
    });

    const nodeStream = Readable.fromWeb(request.body as unknown as WebReadableStream);
    nodeStream.on('data', (chunk: Buffer) => {
      totalWireBytes += chunk.length;
      if (totalWireBytes > maxMediaBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
        fail(
          new PayloadTooLargeError(
            `Multipart upload exceeds maximum allowed size of ${maxMediaBytes} bytes.`,
          ),
        );
      }
    });
    nodeStream.on('error', (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });
    nodeStream.pipe(busboy);
  });
}
