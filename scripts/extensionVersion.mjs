/**
 * 扩展版本号校验 —— **零副作用纯函数模块**(v0.4 Task 2 · spec §8.1 断言 A8)。
 *
 * 为什么单独一个文件:`build-extension.mjs` 顶层就 `await buildOnce()`,
 * 测试一 import 它就会真跑一次构建(删 dist / bundle / 打 zip)—— 测试不该有副作用。
 * 校验逻辑搬到这里后,`extensionVersion.test.ts` 能安全 import,构建脚本照常消费同一份实现。
 */

/**
 * Chromium 对扩展 version 的硬约束:1–4 段、纯数字、点分隔、每段 0–65535,**不接受预发布后缀**。
 * 正则挡形状,逐段比大小挡数值,双重校验。
 *
 * @param {unknown} version
 * @returns {boolean}
 */
export function isValidExtensionVersion(version) {
  if (typeof version !== 'string') return false
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(version)) return false
  return version.split('.').every((segment) => Number(segment) <= 65535)
}

/**
 * **绝不自动裁剪**:`0.4.0-rc1` 静默裁成 `0.4.0` 恰恰制造了它要防的版本漂移 ——
 * 安装包报 `0.4.0-rc1`、扩展报 `0.4.0`,两个工件说两个版本,而且没有任何人被告知。
 * 报错退出则问题在构建期就暴露,零歧义。
 *
 * @param {unknown} version
 * @returns {string} 校验通过的版本号原样返回
 */
export function assertValidExtensionVersion(version) {
  if (!isValidExtensionVersion(version)) {
    throw new Error(
      `package.json 的 version "${String(version)}" 不是合法的扩展版本号。\n` +
        '要求:1–4 段纯数字、以点分隔、每段 0–65535,不接受预发布后缀(如 -rc1 / -beta)。\n' +
        '构建已中止,未产出任何产物。'
    )
  }
  return version
}
