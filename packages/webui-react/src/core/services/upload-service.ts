/**
 * core/services/upload-service.ts —— UploadServicePort 实现（附件上传）
 * 【职责】走 http.upload（FormData 的 file 字段）产出 Attachment：
 *   成功 status='done'（带服务端 path/size）；失败 status='error' 并带 error 文案，
 *   不向调用方抛错（UI 需要把失败也渲染成一条附件记录）。
 * 【接缝】实现 contracts/ports.ts 的 UploadServicePort。
 */
import type { HttpPort, UploadServicePort } from '../../contracts/ports';
import type { Attachment } from '../../contracts/domain';

export interface UploadServiceDeps {
  http: HttpPort;
}

interface UploadResponse {
  ok?: unknown;
  path?: unknown;
  name?: unknown;
  size?: unknown;
}

function makeId(): string {
  const c: unknown = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: unknown }).crypto : undefined;
  if (typeof c === 'object' && c !== null) {
    const gen = (c as { randomUUID?: unknown }).randomUUID;
    if (typeof gen === 'function') return String(gen.call(c));
  }
  return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function createUploadService(deps: UploadServiceDeps): UploadServicePort {
  const { http } = deps;

  return {
    async upload(file: File | Blob, name: string): Promise<Attachment> {
      const id = makeId();
      try {
        const res = (await http.upload('/api/upload', file, name)) as UploadResponse;
        return {
          id,
          name: typeof res.name === 'string' && res.name ? res.name : name,
          path: typeof res.path === 'string' ? res.path : '',
          size: typeof res.size === 'number' ? res.size : file.size ?? 0,
          status: 'done',
        };
      } catch (e) {
        return {
          id,
          name,
          path: '',
          size: 0,
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
