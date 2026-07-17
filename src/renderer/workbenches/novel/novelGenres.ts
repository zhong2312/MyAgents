export interface NovelGenreGroup {
  readonly label: string;
  readonly options: readonly string[];
}

export const NOVEL_GENRE_GROUPS: readonly NovelGenreGroup[] = [
  {
    label: "玄幻",
    options: [
      "玄幻",
      "东方玄幻",
      "异世大陆",
      "王朝争霸",
      "高武世界",
    ],
  },
  {
    label: "仙侠",
    options: ["仙侠", "修真文明", "幻想修仙", "古典仙侠", "现代修真"],
  },
  {
    label: "武侠",
    options: ["武侠", "传统武侠", "现代武侠", "国术无双", "武侠幻想"],
  },
  {
    label: "都市",
    options: [
      "都市",
      "都市生活",
      "都市异能",
      "青春校园",
      "娱乐明星",
      "商战职场",
      "重生",
    ],
  },
  {
    label: "历史",
    options: [
      "历史",
      "架空历史",
      "秦汉三国",
      "两晋隋唐",
      "宋元明清",
      "民国谍战",
      "穿越",
      "争霸",
    ],
  },
  {
    label: "军事",
    options: ["军事", "战争幻想", "军旅生涯", "抗战烽火", "谍战特工"],
  },
  {
    label: "科幻",
    options: [
      "科幻",
      "未来世界",
      "星际文明",
      "时空穿梭",
      "进化变异",
      "赛博朋克",
      "末世",
    ],
  },
  {
    label: "奇幻",
    options: [
      "奇幻",
      "剑与魔法",
      "史诗奇幻",
      "现代魔法",
      "西方奇幻",
    ],
  },
  {
    label: "悬疑",
    options: [
      "悬疑",
      "推理侦探",
      "诡秘悬疑",
      "惊悚恐怖",
      "探险盗墓",
      "克苏鲁",
    ],
  },
  {
    label: "游戏",
    options: [
      "游戏",
      "虚拟网游",
      "电子竞技",
      "游戏异界",
      "无限流",
      "系统流",
    ],
  },
  {
    label: "言情",
    options: [
      "现代言情",
      "古代言情",
      "青春甜宠",
      "豪门总裁",
      "职场婚恋",
      "宫闱宅斗",
    ],
  },
  {
    label: "幻想言情",
    options: ["玄幻言情", "仙侠奇缘", "科幻空间", "无限快穿", "兽世"],
  },
  {
    label: "二次元",
    options: ["轻小说", "衍生同人", "原生幻想", "搞笑吐槽"],
  },
  {
    label: "现实",
    options: ["现实生活", "社会纪实", "家庭伦理", "乡土生活", "种田", "其他"],
  },
] as const;

export const NOVEL_GENRES = Object.freeze(
  NOVEL_GENRE_GROUPS.flatMap((group) => group.options),
);
