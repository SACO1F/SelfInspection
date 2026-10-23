import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

/**
 * 由云服务环境签发，仅包含可公开字段。
 * endpoint / oauthRelayBaseUrl / publishableKey 均来自 publicConfig，不可硬编码替换为其它域名。
 */
const publicConfig = {
  endpoint: 'https://knowledge-quiz-37422.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_bbidett28bPT8awK5Xip5t_9pKeIuAIEr5ERFGeY7ThY5mf1hAWigm3',
}

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
})
