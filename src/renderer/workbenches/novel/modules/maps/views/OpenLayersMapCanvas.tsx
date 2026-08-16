import type { ComponentProps } from "react";

import MapSceneCanvas from "./MapSceneCanvas";

/**
 * 大陆/星球地图的唯一地理画布入口。
 *
 * `MapDocument` 的地理编辑已经包含地形合成、素材笔刷、印章变换和
 * 自动延展等 Wonderdraft 式能力，不能退回只支持普通要素的旧
 * `MapCanvas`。这里保留 OpenLayersMapCanvas 作为投影边界，内部使用
 * MapSceneCanvas 的统一场景渲染表面，保证所有事实仍来自同一个文档。
 */
export type OpenLayersMapCanvasProps = ComponentProps<typeof MapSceneCanvas>;

export default function OpenLayersMapCanvas(props: OpenLayersMapCanvasProps) {
  return <MapSceneCanvas {...props} />;
}
