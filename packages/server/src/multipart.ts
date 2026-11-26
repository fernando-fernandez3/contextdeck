import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import Busboy from 'busboy';
import { ContextDeckError, PayloadTooLargeError, ValidationError } from '@contextdeck/core';

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
    let activeFileStream: NodeJS.ReadableStream | null = null;
    let settled = false;
    let inputEnded = false;
    let totalWireBytes = 0;

    const toMultipartError = (err: unknown): Error => {
      if (err instanceof ContextDeckError) return err;
      const msg = err instanceof Error ? err.message : String(err);
      return new ValidationError(`Invalid or truncated multipart upload: ${msg}`);
    };

    const cleanupTemp = async () => {
      const fsStream = activeFileStream;
      activeFileStream = null;
      const ws = activeWriteStream;
      activeWriteStream = null;

      if (fsStream && ws) {
        fsStream.unpipe(ws);
        fsStream.resume();
      }

      // H13 / H15: Always await the write stream's 'close' before deleting the temp file (Windows safe).
      if (ws && !ws.closed) {
        await new Promise<void>((resClose) => {
          const done = () => resClose();
          ws.once('close', done);
          ws.once('error', done);
          ws.destroy();
        });
      }

      if (activeTmpPath) {
        const toDelete = activeTmpPath;
        activeTmpPath = null;
        await fsp.rm(toDelete, { force: true }).catch(() => {});
      }
    };

    const onAbort = () => {
      fail(new ValidationError('Multipart upload aborted by client.'));
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener('abort', onAbort);
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
      if (settled || fieldName !== 'file') {
        // H13: Swallow errors on ignored parts before draining
        stream.on('error', () => {});
        stream.resume();
        return;
      }

      const tmpPath = path.join(mediaDir, `.tmp-upload-${crypto.randomBytes(8).toString('hex')}`);
      activeTmpPath = tmpPath;
      activeFileStream = stream;
      const ws = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o644 });
      activeWriteStream = ws;

      let fileBytes = 0;
      let hitLimit = false;
      let wsFinished = false;

      fileWritePromise = new Promise<void>((resFile) => {
        let fileResolved = false;
        const finishFile = () => {
          if (!fileResolved) {
            fileResolved = true;
            resFile();
          }
        };

        // H13: Always attach an error listener to Busboy's FileStream so truncated bodies or
        // busboy.destroy() never emit an uncaught 'error' event.
        stream.on('error', (err) => {
          fail(toMultipartError(err));
          finishFile();
        });

        stream.on('limit', () => {
          hitLimit = true;
          stream.unpipe(ws);
          stream.resume();
          const err = new PayloadTooLargeError(
            `Uploaded file exceeds maximum allowed size of ${maxMediaBytes} bytes.`,
          );
          fail(err);
          finishFile();
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
            finishFile();
          }
        });

        ws.on('error', (err) => {
          fail(toMultipartError(err));
          finishFile();
        });

        ws.on('finish', () => {
          wsFinished = true;
        });

        ws.on('close', async () => {
          if (activeWriteStream === ws) {
            activeWriteStream = null;
          }
          if (!wsFinished || hitLimit || settled) {
            finishFile();
            return;
          }
          try {
            const fh = await fsp.open(tmpPath, 'r+');
            try {
              await fh.sync();
            } finally {
              await fh.close();
            }
            fileResult = {
              tmpPath,
              fileName: info.filename || 'upload.bin',
              mimeType: info.mimeType || 'application/octet-stream',
              bytesWritten: fileBytes,
            };
            finishFile();
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
            finishFile();
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
      fail(toMultipartError(err));
    });

    busboy.on('close', () => {
      if (settled) return;
      const done = fileWritePromise ?? Promise.resolve();
      done
        .then(() => {
          if (settled) return;
          settled = true;
          request.signal?.removeEventListener('abort', onAbort);
          activeTmpPath = null; // ownership transferred to caller
          resolve({ fields, file: fileResult });
        })
        .catch((err) => {
          fail(toMultipartError(err));
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
    nodeStream.on('end', () => {
      inputEnded = true;
    });
    nodeStream.on('error', (err) => {
      fail(toMultipartError(err));
    });
    nodeStream.on('close', () => {
      if (!inputEnded && !settled) {
        fail(new ValidationError('Multipart upload aborted before completion.'));
      }
    });
    if (request.signal) {
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });
    }
    nodeStream.pipe(busboy);
  });
}
