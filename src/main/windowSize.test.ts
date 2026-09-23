/** 窗口下限来自用户两维实测 + 独立余量；布局目视仍归用户手测。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

test('#41-b BrowserWindow 有 minWidth / minHeight 且等于实测值', () => {
  // 只解析实际启动配置，避免导入 index.ts 时启动引擎、数据库或原生窗口。
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const createWindow = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'createWindow'
  )
  assert.ok(createWindow?.body, '主窗口创建函数必须存在')

  const windows: ts.NewExpression[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'BrowserWindow'
    ) {
      windows.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(createWindow.body)
  assert.equal(windows.length, 1, '必须定位到唯一的主窗口配置')
  const options = windows[0].arguments?.[0]
  assert.ok(options && ts.isObjectLiteralExpression(options), '主窗口配置必须是对象字面量')

  for (const [name, expected] of [
    ['minWidth', 640],
    ['minHeight', 560]
  ] as const) {
    const properties = options.properties.filter(
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === name
    )
    assert.equal(properties.length, 1, name + ' 必须存在且仅出现一次')
    const value = properties[0].initializer
    assert.ok(ts.isNumericLiteral(value), name + ' 必须是实测后确定的数值')
    assert.equal(Number(value.text), expected, name + ' 必须保持实测值及其独立余量')
  }
})
