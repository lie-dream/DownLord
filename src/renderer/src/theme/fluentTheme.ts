/**
 * Fluent UI 主题对象(Fluent 2 / Win11)— 基于 DESIGN.md §2 品牌主色生成。
 *
 * - `lightTheme` / `darkTheme` 交给 FluentProvider,管理 Fluent 控件样式。
 * - 关键 token(背景层 / 描边 / 文字 / 语义色)覆盖为与 DESIGN 对齐的值,保持与 tokens.css 单一来源。
 * - 品牌色用 `BrandVariants` 生成色阶,基于 DESIGN 的主色 #0f6cbd(浅) / #479ef5(深)。
 */

import {
  createLightTheme,
  createDarkTheme,
  type BrandVariants,
  type Theme
} from '@fluentui/react-components'

/**
 * 品牌色阶(基于 DESIGN §2 浅色主色 #0f6cbd)。
 * Fluent 要求 10~160 共 16 档,这里以主色为锚点手动配置关键档,其余由 Fluent 插值。
 */
const brandVariants: BrandVariants = {
  10: '#f5f9fd', // 极浅 subtle 背景
  20: '#e1f0fc',
  30: '#c7e3fa',
  40: '#9fcdf7',
  50: '#6eb4f3',
  60: '#479ef5', // 深色主题主色(偏亮)
  70: '#2b88de',
  80: '#0f6cbd', // 浅色主题主色(DESIGN 品牌色锚点)
  90: '#115ea3', // hover
  100: '#0e4775', // pressed
  110: '#0d3c63',
  120: '#0c3251',
  130: '#0a2840',
  140: '#081e2f',
  150: '#06141e',
  160: '#040a0d'
}

/**
 * 浅色主题:覆盖 Fluent 默认 token,对齐 DESIGN §2 浅色值。
 */
export const lightTheme: Theme = {
  ...createLightTheme(brandVariants),
  // 覆盖关键 token 使其与 DESIGN / tokens.css 一致
  colorNeutralBackground1: '#f3f3f3', // --bg-base
  colorNeutralBackground2: '#ffffff', // --bg-layer
  colorNeutralBackground3: '#fafafa', // --bg-layer-alt
  colorNeutralStroke1: 'rgba(0, 0, 0, 0.0578)', // --stroke
  colorNeutralForeground1: '#1a1a1a', // --text-primary
  colorNeutralForeground2: '#5c5c5c', // --text-secondary
  colorNeutralForeground3: '#8a8a8a', // --text-tertiary
  colorBrandForeground1: '#0f6cbd', // --brand
  colorBrandBackground: '#0f6cbd'
}

/**
 * 深色主题:覆盖关键 token 对齐 DESIGN §2 深色值。
 */
export const darkTheme: Theme = {
  ...createDarkTheme(brandVariants),
  colorNeutralBackground1: '#202020', // --bg-base
  colorNeutralBackground2: '#2b2b2b', // --bg-layer
  colorNeutralBackground3: '#323232', // --bg-layer-alt
  colorNeutralStroke1: 'rgba(255, 255, 255, 0.0837)', // --stroke
  colorNeutralForeground1: '#ffffff', // --text-primary
  colorNeutralForeground2: '#c8c8c8', // --text-secondary
  colorNeutralForeground3: '#969696', // --text-tertiary
  colorBrandForeground1: '#479ef5', // --brand
  colorBrandBackground: '#479ef5'
}
