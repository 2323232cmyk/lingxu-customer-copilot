import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  OPEN_WECHAT_READER_MANIFEST,
  type WechatNativeResourceEntry,
  type WechatNativeResourceManifest,
} from './manifest';

export type ResourceVersionStatus = 'match' | 'mismatch' | 'unverified';

export interface ResourceMismatch {
  readonly relativePath: string;
  readonly reason: 'size' | 'sha256' | 'not-file';
  readonly expected: string | number;
  readonly actual: string | number;
}

export interface WechatNativeResourceProbeResult {
  readonly resourceRoot: string;
  readonly sourceProduct: string;
  readonly expectedVersion: string;
  readonly versionStatus: ResourceVersionStatus;
  readonly available: boolean;
  readonly checkedFiles: number;
  readonly missingFiles: readonly string[];
  readonly mismatchedFiles: readonly ResourceMismatch[];
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function inspectResource(
  resourceRoot: string,
  resource: WechatNativeResourceEntry,
): Promise<{ missing?: string; mismatch?: ResourceMismatch }> {
  const filePath = resolve(resourceRoot, resource.relativePath);

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { missing: resource.relativePath };
    }
    throw error;
  }

  if (!fileStat.isFile()) {
    return {
      mismatch: {
        relativePath: resource.relativePath,
        reason: 'not-file',
        expected: 'file',
        actual: 'not-file',
      },
    };
  }

  if (fileStat.size !== resource.size) {
    return {
      mismatch: {
        relativePath: resource.relativePath,
        reason: 'size',
        expected: resource.size,
        actual: fileStat.size,
      },
    };
  }

  const actualHash = await sha256(filePath);
  if (actualHash !== resource.sha256) {
    return {
      mismatch: {
        relativePath: resource.relativePath,
        reason: 'sha256',
        expected: resource.sha256,
        actual: actualHash,
      },
    };
  }

  return {};
}

export async function probeWechatNativeResources(
  resourceRoot: string,
  manifest: WechatNativeResourceManifest = OPEN_WECHAT_READER_MANIFEST,
): Promise<WechatNativeResourceProbeResult> {
  const resolvedRoot = resolve(resourceRoot);
  const inspections = await Promise.all(
    manifest.resources.map((resource) => inspectResource(resolvedRoot, resource)),
  );
  const missingFiles = inspections.flatMap((inspection) =>
    inspection.missing ? [inspection.missing] : [],
  );
  const mismatchedFiles = inspections.flatMap((inspection) =>
    inspection.mismatch ? [inspection.mismatch] : [],
  );
  const available = missingFiles.length === 0 && mismatchedFiles.length === 0;
  const versionStatus: ResourceVersionStatus = available
    ? 'match'
    : mismatchedFiles.length > 0
      ? 'mismatch'
      : 'unverified';

  return {
    resourceRoot: resolvedRoot,
    sourceProduct: manifest.sourceProduct,
    expectedVersion: manifest.sourceVersion,
    versionStatus,
    available,
    checkedFiles: manifest.resources.length - missingFiles.length,
    missingFiles,
    mismatchedFiles,
  };
}
