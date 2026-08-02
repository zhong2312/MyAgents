// Vue SFC 类型声明：世界实验室以 Vue 微前端方式复用上游 MiroFish 组件
// （src/renderer/workbenches/novel/mirofish/*.vue）。tsc 不编译 .vue 文件，
// 这里提供最小声明让类型检查通过；组件内部的完整类型检查由
// @vitejs/plugin-vue 在构建期完成。
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
