# React 稳定性规范

> **核心原则**：React 重新渲染时，对象/函数引用会改变。依赖这些引用的 useEffect 会重新执行，可能触发 API 调用、文件访问等副作用。

## 规则 1：Context Provider 必须 useMemo

Provider value 必须使用 `useMemo` 包装，否则每次渲染都会创建新对象，导致所有消费者重新渲染。

```typescript
// ✅ 正确
const contextValue = useMemo(() => ({
    showToast, success, error, warning, info
}), [showToast, success, error, warning, info]);

return <ToastContext.Provider value={contextValue}>{children}</ToastContext.Provider>;

// ❌ 错误：对象字面量每次渲染都是新引用
return <ToastContext.Provider value={{ showToast, success, error }}>{children}</ToastContext.Provider>;
```

## 规则 2：useEffect 依赖数组规范

**禁止**将以下内容放入依赖数组（除非确实需要响应其变化）：

| 禁止依赖 | 原因 | 替代方案 |
|----------|------|----------|
| `toast` hook 返回值 | 可能不稳定 | 在 effect 内部调用，不加依赖 |
| `api` 对象 | 依赖 Provider 稳定性 | 使用 `useRef` 缓存 |
| inline callback | 每次渲染新引用 | `useCallback` 或 `useRef` |
| 对象/数组字面量 | 每次渲染新引用 | `useMemo` 包装 |

```typescript
// ✅ 正确：稳定依赖
useEffect(() => {
    loadData();
}, [id]);  // 只依赖原始值

// ❌ 错误：不稳定依赖导致无限循环
useEffect(() => {
    loadData();
}, [id, toast, api, { config }]);  // toast/api/对象字面量都不稳定
```

## 规则 3：跨组件回调稳定化

父组件传递给子组件的回调，若在子组件 useEffect 中使用，必须稳定化：

```typescript
// 子组件内部
const onChangeRef = useRef(onChange);
onChangeRef.current = onChange;  // 每次渲染更新

useEffect(() => {
    onChangeRef.current?.(value);  // 使用 ref 调用
}, [value]);  // 不依赖 onChange
```

## 规则 4：定时器必须清理

```typescript
const timeoutRef = useRef<NodeJS.Timeout>();

useEffect(() => {
    timeoutRef.current = setTimeout(doSomething, 1000);
    return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
}, []);
```

## 规则 5：memo + ref 稳定化模式（渲染列表优化）

当父组件用 `state.map()` 渲染子组件列表时，state 变化会重渲染所有子组件。若子组件很重（如 Chat），需用 `memo` + ref 稳定化回调实现精准重渲染：

**三步范式**：

```typescript
// Step 1: Ref 同步——回调通过 ref 读取最新 state，依赖数组为空
const stateRef = useRef(state);
stateRef.current = state;

const stableCallback = useCallback(() => {
    // 使用 stateRef.current 而非 state
    const item = stateRef.current.find(...);
}, []);  // 永远稳定

// Step 2: memo 子组件——自定义 comparator 只比较数据 props（回调已稳定，无需比较）
const MemoChild = memo(function Child(props) { ... }, (prev, next) => {
    return prev.data === next.data && prev.isActive === next.isActive;
    // 回调 props 不比较，因为已通过 Step 1 保证稳定
});

// Step 3: 仅传递与该子组件相关的数据 props（避免无关 prop 变化触发重渲染）
{items.map(item => (
    <MemoChild
        key={item.id}
        data={item}
        isActive={item.id === activeId}
        onAction={stableCallback}  // 引用永远不变
    />
))}
```

**关键约束**：
- 自定义 comparator 跳过回调检查的前提是 **所有回调 props 确实稳定**（`[]` 依赖）。若某个回调依赖了不稳定值（如来自 hook 的函数），必须用 ref 包一层
- `setTabs(prev => prev.map(...))` 会保留未变更 item 的对象引用，使 `prev.data === next.data` 生效
- 仅影响特定子组件类型的 prop，用条件表达式限制传递范围

## 扩展模式

### 模式 A：多 Ref 同步稳定复杂依赖

当 `useCallback` 需要依赖多个 hook 返回值时，通过 Ref 同步避免 callback 频繁重建：

```typescript
const configRef = useRef(config);
configRef.current = config;
const apiKeysRef = useRef(apiKeys);
apiKeysRef.current = apiKeys;

const buildProviderEnv = useCallback((provider) => {
  const aliases = getEffectiveModelAliases(provider, configRef.current.providerModelAliases);
  return { apiKey: apiKeysRef.current[provider.id], ... };
}, []);  // 依赖为空 → 永不重建
```

**应用**：`Chat.tsx` 的 `buildProviderEnv`、`handleSendMessage`。

### 模式 B：isMountedRef 防竞态

异步操作完成前检查组件是否仍 mounted：

```typescript
const isMountedRef = useRef(false);
useEffect(() => {
  isMountedRef.current = true;
  return () => { isMountedRef.current = false; };
}, []);

loadData().then(result => {
  if (!isMountedRef.current) return;
  setState(result);
});
```

setup 必须显式恢复 `true`：React StrictMode 会执行 effect setup → cleanup → setup 来验证清理对称性；只在初始化器写一次 `true` 会让第二次 setup 永久停留在 `false`，后续合法异步结果全部被误判为 unmounted。

**应用**：`ConfigProvider`、`TabProvider`、`BotPlatformRegistry`。

### 模式 C：Dual Context 分离数据与行为

当 Context 消费者众多且数据变化频繁时，将 data 和 actions 分为两个 Context：

```typescript
export const ConfigDataContext = createContext<ConfigDataValue>(null);
export const ConfigActionsContext = createContext<ConfigActionsValue>(null);
```

**优势**：Actions 保持稳定引用，数据变化不导致 action 消费者重渲染。
**应用**：`ConfigProvider`（`ConfigDataContext` + `ConfigActionsContext`）。
