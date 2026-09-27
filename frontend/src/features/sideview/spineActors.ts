import { Texture } from 'pixi.js';
import { TextureAtlas } from '@pixi-spine/base';
import { AtlasAttachmentLoader, SkeletonBinary, Spine } from '@pixi-spine/runtime-3.8';
import { resolveAnimSpec } from '../../components/combat/spineAnimSpecs';
import { getBaseUrl } from '../../utils/baseUrl';

export { hasSpineVariant as hasSideviewSpine } from '../../utils/spineVariants';

export async function loadSideviewSpine(name: string, variant: string) {
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
