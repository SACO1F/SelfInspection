/**
 * 站点级默认模型：由站主在 app_settings 表里配置，供所有访客使用。
 * 优先级：用户自己配的模型 > 站点默认模型 > 平台内置通道。
 *
 * 注意：这张表对访客可读，因此 key 对任何打开页面的人都可见。
 * 这是前端直连第三方模型的固有代价，只能在服务商侧设额度上限来控制风险。
 */
import { cloud } from '../cloud'

export interface SiteModel {
  endpoint: string
  apiKey: string
  model: string
}

let cached: SiteModel | null | undefined

export async function loadSiteModel(): Promise<SiteModel | null> {
  if (cached !== undefined) return cached

  try {
    const { data, error } = await cloud.database
      .from('app_settings')
      .select('endpoint,api_key,model')
      .eq('id', 1)
      .maybeSingle()

    if (error || !data) {
      cached = null
      return null
    }

    const endpoint = String(data.endpoint || '').trim()
    const apiKey = String(data.api_key || '').trim()
    const model = String(data.model || '').trim()
    cached = endpoint && apiKey && model ? { endpoint, apiKey, model } : null
  } catch {
    cached = null
  }

  return cached
}
