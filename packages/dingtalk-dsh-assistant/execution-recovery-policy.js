// Host服务与控制事务共用分类；未列入暂态白名单的错误不能自动重领。
export const engineeringPatchRepairReasons = Object.freeze(['ENGINEERING_PATCH_AMBIGUOUS', 'ENGINEERING_PATCH_CONFLICT', 'ENGINEERING_PATCH_BASE_CONFLICT'])
export const transientRecoveryReasons = Object.freeze(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'PLATFORM_REQUEST_FAILED',
  'PLATFORM_HTTP_429', 'PLATFORM_HTTP_502', 'PLATFORM_HTTP_503', 'PLATFORM_HTTP_504', 'ENGINEERING_REMOTE_READ_TRANSIENT', 'controller-restarted'])
export const recoveryRetryLimit = 3
export const recoveryRetryDelayMs = attempt => 1000 * 2 ** (attempt - 1)
