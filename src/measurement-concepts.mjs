// Finite topic aliases, not unit conversion or inferred body measurements.
// A mention can be an explicit unknown or counterexample. Keep its whole text.
const concepts = [
  { key: 'shoeSize', label: '鞋码', pattern: /鞋码|鞋号|鞋.{0,10}(?:几号|几码|多大码)|\bshoe sizes?\b|\bsize (?:of )?(?:my )?shoes?\b|(?:鞋|靴)[^。；;\n]{0,16}\b(?:eu|cn|us|uk)\s*\d/ },
  { key: 'footLength', label: '脚长', pattern: /脚长|足长|(?:脚|足)(?:的|实际|本身|实测|有|量|踩)[^。；;\n]{0,16}(?:长|测)|把脚.{0,10}量|\b(?:foot|feet) lengths?\b|\bhow long (?:are|is) (?:my |the )?(?:feet|foot)\b/ },
  { key: 'insoleLength', label: '鞋垫长度', pattern: /鞋垫(?:的|本身)?(?:内)?(?:长度|长|有多长)|\binsole (?:lengths?|measurements?)\b/ },
  { key: 'clothingSize', label: '衣服尺码', pattern: /(?:衣服|上衣|衬衫|外套|裤子|手套|帽子)(?:的)?(?:尺码|尺寸)?|服装尺码|\b(?:clothing|clothes|shirt|jacket|trousers|pants|gloves|hat) sizes?\b/ },
  { key: 'height', label: '身高', pattern: /身高|个子|个头|\bheight\b|\bhow tall am i\b/ },
  { key: 'weight', label: '体重', pattern: /体重|\bweight\b|\bweigh\b/ },
];
const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase();

export function measurementConcepts(value) {
  const text = normalize(value);
  return concepts.filter(concept => concept.pattern.test(text)).map(({ key, label, pattern }) => ({ key, label, queryAlias: pattern.exec(text)[0] }));
}

export function measurementLabels(value) {
  return measurementConcepts(value).map(concept => concept.label);
}

export function incompatibleMeasurements(documentConcepts, requestedConcepts) {
  return requestedConcepts.length > 0 && documentConcepts.length > 0
    && !documentConcepts.some(concept => requestedConcepts.some(requested => requested.key === concept.key));
}

export function ownerMeasurementRequest(value) {
  const text = normalize(value);
  // Only a finite modifier list may intervene between the owner and the body
  // or garment. In particular, "my friend's measured foot" is not my foot.
  return /(?:我的?|本人的|用户的)(?:(?:实际|实测|当前|目前|自己的|已记录的|测量的|记录的)\s*){0,3}(?:左脚|右脚|脚|足|鞋垫|衣服|上衣|衬衫|外套|裤子)|\bmy(?:\s+(?:own|measured|actual|current|recorded|left|right)){0,3}\s+(?:foot|feet|insole|clothing|clothes|shirt|jacket|pants)\b/.test(text);
}

export function measurementFieldObject(value) {
  return /(?:脚长|足长|鞋垫长度|衣服尺码|\b(?:foot length|insole length|clothing size)\b)\s*(?:输入框|组件|字段|选择器|variable|input|component|field|selector)/.test(normalize(value));
}
