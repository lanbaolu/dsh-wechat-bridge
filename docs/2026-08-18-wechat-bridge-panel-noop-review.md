# 2026-08-18 微信桥接管理面板标签点击无反应 — 复查记录

## 反馈

用户反馈 Web 管理面板 `@dsh-external/dsh-wechat-bridge` 标签点击无反应。

## 根因

历史版本在 `src/client/index.ts` 中把 `conversation.view` / `settings.section` 槽位注册成了：

```ts
ctx.slots.register({
  // ...
  component: () => ({ render() { return createPanel() } }),
})
```

但该槽位期望第二个参数直接是 React 组件。注册成普通对象/工厂后，React 渲染层无法按组件处理，导致标签点击后空白/无反应。

## 修复

已通过提交 `091ef88`（`fix: register conversation.view panel as React component`）修复：

- 新增 `src/client/Panel.tsx`，导出 `WechatBridgePanel` React 函数组件（`useState` / `useEffect` 管理状态）。
- `src/client/index.ts` 改为 `ctx.slots.register(options, WechatBridgePanel)` 两参形式。
- `tsconfig.json` 增加 `"jsx": "react-jsx"`，并加入 `@types/react`。

当前 `src/client/index.ts` 注册代码：

```ts
ctx.effect(() => ctx.slots.inject('settings.section', () =>
  ctx.slots.register({
    name: 'settings.section',
    id: '@lanbaolu/dsh-wechat-bridge-panel',
    order: 55,
    label: () => '📱 微信桥接',
  }, WechatBridgePanel),
), '@lanbaolu/dsh-wechat-bridge: panel')
```

## 复查结论

- 源码已是 React 组件两参注册，不再使用 `options.component` 旧形态。
- `npm run typecheck` 通过。
- `npm run build` / `npm run build:client` 通过，`lib/client.js` 中已包含 `WechatBridgePanel` 与两参注册调用。
- 结论：该问题已修复；剩余建议是在真实 DSH Web 面板中做一次浏览器点击回归。
