import type { AppData } from "./model";
import { cleanupCompletedCloudImages, imageCleanupAccountKey } from "./imageLibrary";
import { plusEnabled, plusStore } from "./plus";

/** 只有当前已验证Plus账号能触发自动清理；长请求不可借用切换后的账号偏好。 */
export function cleanupImagesForActiveAccount(data: AppData, expectedAccount?: string): AppData {
  const account = plusStore.getState().account;
  if (!plusEnabled() || !account || expectedAccount !== undefined && imageCleanupAccountKey(expectedAccount) !== account) return data;
  return cleanupCompletedCloudImages(data, account);
}
