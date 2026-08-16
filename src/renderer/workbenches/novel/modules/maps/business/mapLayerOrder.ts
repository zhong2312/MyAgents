/**
 * 图层面板从上到下展示前景到背景。Canvas 和 PNG 需要反向绘制，才能让面板中
 * 靠上的图层覆盖靠下的图层；同一图层内部继续保持要素创建顺序。
 */
export function mapFeaturesInRenderOrder<
  TLayer extends { readonly id: string },
  TFeature extends { readonly layerId: string },
>(document: {
  readonly layers: readonly TLayer[];
  readonly features: readonly TFeature[];
}): readonly TFeature[] {
  const layerOrder = new Map(
    document.layers.map((layer, index) => [layer.id, index]),
  );
  return document.features
    .map((feature, index) => ({
      feature,
      index,
      layerIndex: layerOrder.get(feature.layerId),
    }))
    .sort((left, right) => {
      if (left.layerIndex === undefined || right.layerIndex === undefined) {
        if (left.layerIndex === right.layerIndex)
          return left.index - right.index;
        return left.layerIndex === undefined ? -1 : 1;
      }
      return right.layerIndex - left.layerIndex || left.index - right.index;
    })
    .map(({ feature }) => feature);
}
