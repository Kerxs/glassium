/**
 * 资源账本：后端现在占着多少显存（估计）。给调试面板、性能测试页与 stats() 看 —— 知道钱花在哪里，才谈得上预算。
 *
 * 只数 Glassium 自己分配的纹理与画布：模糊链与草稿（带 mip）、层的来源与备份、图集、用户场景的纹理、画布本身
 * （按双缓冲算）。uniform 缓冲、管线、驱动自己的开销不数（小，也量不到）；探针的 rgba32float 目标用完就放，不数。
 * 字节数按格式与尺寸算，驱动实际的对齐、压缩会有出入 —— 这是估计，够比较「哪一项大」「换了尺寸之后变了多少」。
 */

/** 一张纹理（含 mip 链）的字节数：各级尺寸各自向下取整、至少 1。 */
export function textureBytes(width: number, height: number, bytesPerTexel = 4, mipLevels = 1): number {
  let total = 0
  for (let k = 0; k < Math.max(1, mipLevels); k++) {
    total += Math.max(1, Math.floor(width / 2 ** k)) * Math.max(1, Math.floor(height / 2 ** k)) * bytesPerTexel
  }
  return total
}

/** 后端的资源账。 */
export interface ResourceUsage {
  /** 合计字节数（估计）。 */
  readonly bytes: number
  /** 纹理数（含画布）。 */
  readonly textures: number
  /** 每一项的字节数：chain、scratch、layerSource、layerBackup、atlas、sceneImage、canvas。没分配的不列。 */
  readonly items: Readonly<Record<string, number>>
}

/** 把各项合起来（值是 0 或没有的不列）。 */
export function usage(items: Record<string, number | null | undefined>): ResourceUsage {
  const kept: Record<string, number> = {}
  let bytes = 0
  let textures = 0
  for (const [k, v] of Object.entries(items)) {
    if (!v || !(v > 0)) continue
    kept[k] = v
    bytes += v
    textures++
  }
  return { bytes, textures, items: kept }
}

export const EMPTY_USAGE: ResourceUsage = Object.freeze({ bytes: 0, textures: 0, items: Object.freeze({}) })

/** 字节数写成人读的（KB / MB）。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}
