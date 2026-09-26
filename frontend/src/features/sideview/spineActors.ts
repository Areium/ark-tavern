import { Texture } from 'pixi.js';
import { TextureAtlas } from '@pixi-spine/base';
import { AtlasAttachmentLoader, SkeletonBinary, Spine } from '@pixi-spine/runtime-3.8';
import { resolveAnimSpec } from '../../components/combat/spineAnimSpecs';
import { getBaseUrl } from '../../utils/baseUrl';

// Same battle variants as PixiCombatScene; kept local to avoid changing its public contract.
const SPINE_VARIANT: Record<string, string> = {
  "临光": "char_148_nearl_summer_2",
  "佐菲娅": "char_265_sophia_epoque_11",
  "德克萨斯": "char_1028_texas2_epoque_36",
  "玛恩纳·临光": "char_4064_mlynar/char_4064_mlynar_iteration_3",
  "瑕光": "char_423_blemsh/char_423_blemsh_witch_2",
  "砾": "char_237_gravel/char_237_gravel_winter_2",
  "银灰": "char_172_svrash/char_172_svrash_snow_1",
  "闪灵": "char_147_shining/char_147_shining_summer_1",
  "阿米娅": "char_002_amiya/char_002_amiya_test_1",
  "陈": "char_010_chen/char_010_chen_nian_2",
  "灵知": "char_206_gnosis",
  "初雪": "char_174_slbell",
  "崖心": "char_173_slchan",
  "锏": "char_4116_blkkgt",
  // 红松骑士团 / 卡西米尔线（fexli/ArknightsResource main，含 Idle/Attack/Die）
  "焰尾": "char_420_flamtl",
  "灰毫": "char_431_ashlok",
  "野鬃": "char_496_wildmn",
  "远牙": "char_430_fartth",
  "薇薇安娜": "char_4098_vvana",
  // 使徒 / 罗德岛线
  "白金": "char_204_platnm",
  "暴行": "char_230_savage",
  "耶拉": "char_4013_kjera",
  "凯尔希": "char_003_kalts",
};

// 敌人 Spine 变体 — 约定与角色一致：文件放 data/worldbooks/content/characters/<敌名>/spine/<变体>/Front|Back/，
// 在此注册敌名即可启用；未注册或加载失败的敌人自动回退 fallback token。
// 来源 Ark-Models models_enemies（tools/import_spine.py enemies），均含 Idle/Attack/Die。
const ENEMY_SPINE_VARIANT: Record<string, string> = {
  "整合运动士兵": "enemy_1002_nsabr",
  "整合运动术师": "enemy_1011_wizard",
  "整合运动狙击手": "enemy_1003_ncbow",
  "整合运动盾卫": "enemy_1006_shield",
  "冰原战士": "enemy_1189_krgaxe",
  "冰原猎人": "enemy_1190_krgbow",
  "冰原术师": "enemy_1192_krgscr",
  "冰原狂战士": "enemy_1193_krgbsk",
  "山雪鬼": "enemy_1194_krgmtr",
  "山雪鬼队长": "enemy_1194_krgmtr_2",
  "雪原爪兽": "enemy_1187_krghd",
};

const SPINE_VARIANT_ALL: Record<string, string> = { ...SPINE_VARIANT, ...ENEMY_SPINE_VARIANT };
export const hasSideviewSpine = (name: string) => Object.prototype.hasOwnProperty.call(SPINE_VARIANT_ALL, name);


export async function loadSideviewSpine(name: string) {
  const variant = hasSideviewSpine(name) ? SPINE_VARIANT_ALL[name] : undefined;
  if (!variant) throw new Error(`${name}暂无本地战斗模型`);
  const base = `${await getBaseUrl()}/api/assets/characters/${encodeURIComponent(name)}/spine/${variant}/Front`;
  const file = variant.split('/').pop()!;
  const read = async (suffix: string) => {
    const response = await fetch(`${base}/${file}.${suffix}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${name}模型资源不可用（${response.status}）`);
    return response;
  };
  const [atlasText, binary] = await Promise.all([read('atlas').then(r => r.text()), read('skel').then(r => r.arrayBuffer())]);
  const atlas = await new Promise<TextureAtlas>((resolve, reject) => {
    new TextureAtlas(atlasText, (path, done) => {
      Texture.fromURL(`${base}/${path}`).then(t => done(t.baseTexture)).catch(reject);
    }, value => value ? resolve(value) : reject(new Error('纹理图集不可用')));
  });
  const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas)).readSkeletonData(new Uint8Array(binary));
  if (!data.defaultSkin && data.skins.length) data.defaultSkin = data.skins[0];
  return data;
}
export function makeSideviewSpine(data: Awaited<ReturnType<typeof loadSideviewSpine>>) {
  const spine = new Spine(data);
  spine.autoUpdate = false;
  const names = data.animations.map(a => a.name);
  const spec = resolveAnimSpec(names);
  if (spec.idle) spine.state.setAnimation(0, spec.idle, true);
  spine.update(0);
  const bounds = spine.getLocalBounds();
  // Begin/Down/Up are transitions, not gait cycles (shield and soldier assets contain both).
  const move = names.find(n => /^(move|walk)_loop$/i.test(n)) ?? names.find(n => /^(move|walk|run)$/i.test(n));
  const run = names.find(n => /^run_loop$/i.test(n)) ?? names.find(n => /^run$/i.test(n)) ?? move;
  const pose = { stride: 0, amount: 0 };
  // Battle skins often have no locomotion clip in either Front or Back. Keep the
  // selected outfit: offset existing leg IK targets, never splice incompatible rigs.
  const feet = ['Ik_F_L_Leg', 'Ik_F_R_Leg'].map(n => spine.skeleton.findBone(n));
  const saved = feet.map(() => ({ x: 0, y: 0 }));
  const worldTransform = spine.skeleton.updateWorldTransform.bind(spine.skeleton);
  spine.skeleton.updateWorldTransform = () => {
    worldTransform();
    if (!pose.amount) return;
    feet.forEach((bone, i) => {
      if (!bone?.parent) return;
      saved[i].x = bone.x; saved[i].y = bone.y;
      const step = Math.sin(pose.stride + i * Math.PI);
      const dx = step * 28 * pose.amount, dy = -Math.max(0, Math.cos(pose.stride + i * Math.PI)) * 24 * pose.amount;
      const { a, b, c, d } = bone.parent.matrix, det = a * d - b * c;
      if (Math.abs(det) < 0.0001) return;
      bone.x += (d * dx - c * dy) / det;
      bone.y += (a * dy - b * dx) / det;
    });
    worldTransform();
    // Local offsets must not accumulate when an animation omits an IK timeline.
    feet.forEach((bone, i) => { if (bone?.parent) { bone.x = saved[i].x; bone.y = saved[i].y; } });
  };
  return { spine, spec, bottom: bounds.y + bounds.height, move, run, pose, stride: 0, land: 0, grounded: true, action: '', attacking: false, attackPlaying: false, dead: false };
}
