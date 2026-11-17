import { parseBirthday, userToday, validateAge } from './profile-attributes.js';

// Small, local convenience catalogues. Unlisted places and legacy values stay
// editable through an explicit custom option; this is not a geocoding service.
const REGIONS = {
  '北京': ['北京'], '天津': ['天津'], '河北': ['石家庄', '唐山', '保定', '秦皇岛', '邯郸'],
  '山西': ['太原', '大同', '运城'], '内蒙古': ['呼和浩特', '包头', '鄂尔多斯'],
  '辽宁': ['沈阳', '大连', '鞍山'], '吉林': ['长春', '吉林', '延边'], '黑龙江': ['哈尔滨', '齐齐哈尔', '大庆'],
  '上海': ['上海'], '江苏': ['南京', '苏州', '无锡', '常州', '南通', '徐州', '扬州'],
  '浙江': ['杭州', '宁波', '温州', '嘉兴', '绍兴', '金华', '湖州', '台州', '舟山', '衢州', '丽水'],
  '安徽': ['合肥', '芜湖', '蚌埠', '安庆', '黄山'], '福建': ['福州', '厦门', '泉州', '漳州'],
  '江西': ['南昌', '九江', '赣州', '景德镇'], '山东': ['济南', '青岛', '烟台', '潍坊', '临沂', '威海'],
  '河南': ['郑州', '洛阳', '开封', '南阳'], '湖北': ['武汉', '宜昌', '襄阳'],
  '湖南': ['长沙', '株洲', '湘潭', '衡阳', '岳阳'], '广东': ['广州', '深圳', '珠海', '佛山', '东莞', '惠州', '中山', '汕头'],
  '广西': ['南宁', '桂林', '柳州', '北海'], '海南': ['海口', '三亚'],
  '重庆': ['重庆'], '四川': ['成都', '绵阳', '德阳', '乐山', '宜宾'], '贵州': ['贵阳', '遵义'],
  '云南': ['昆明', '大理', '丽江', '曲靖'], '西藏': ['拉萨', '日喀则'],
  '陕西': ['西安', '咸阳', '宝鸡'], '甘肃': ['兰州', '天水'], '青海': ['西宁'],
  '宁夏': ['银川'], '新疆': ['乌鲁木齐', '喀什'], '香港': ['香港'], '澳门': ['澳门'],
  '台湾': ['台北', '新北', '台中', '台南', '高雄'],
};
const PLACES = {
  '中国': REGIONS,
  '日本': { '东京都': ['东京'], '大阪府': ['大阪'], '京都府': ['京都'], '神奈川县': ['横滨'], '北海道': ['札幌'], '福冈县': ['福冈'] },
  '新加坡': { '新加坡': ['新加坡'] },
  '美国': { '加利福尼亚州': ['旧金山', '洛杉矶', '圣何塞', '圣迭戈'], '纽约州': ['纽约'], '华盛顿州': ['西雅图'], '马萨诸塞州': ['波士顿'], '得克萨斯州': ['奥斯汀', '休斯敦', '达拉斯'] },
  '加拿大': { '安大略省': ['多伦多', '渥太华'], '不列颠哥伦比亚省': ['温哥华'], '魁北克省': ['蒙特利尔', '魁北克'] },
  '英国': { '英格兰': ['伦敦', '曼彻斯特', '伯明翰'], '苏格兰': ['爱丁堡', '格拉斯哥'], '威尔士': ['卡迪夫'], '北爱尔兰': ['贝尔法斯特'] },
  '澳大利亚': { '新南威尔士州': ['悉尼'], '维多利亚州': ['墨尔本'], '昆士兰州': ['布里斯班'], '西澳大利亚州': ['珀斯'] },
  '德国': { '柏林': ['柏林'], '巴伐利亚州': ['慕尼黑'], '黑森州': ['法兰克福'] },
  '法国': { '法兰西岛': ['巴黎'], '奥弗涅-罗讷-阿尔卑斯': ['里昂'] },
  '韩国': { '首尔': ['首尔'], '釜山': ['釜山'], '京畿道': ['水原'] },
};
export const PROFILE_PICKER_UNITS = Object.freeze({
  height: Object.freeze(['cm', 'm', 'mm', 'ft', 'in']),
  weight: Object.freeze(['kg', '斤', 'lb', 'g']),
  shoeSize: Object.freeze(['EU', 'CN', 'US男', 'US女', 'UK', 'JP', 'KR', 'mm', 'cm', '码']),
});
const CHOICES = {
  occupation: ['AI 应用开发工程师', '软件工程师', '产品经理', '设计师', '教师', '研究人员', '学生', '自由职业者', '创业者', '暂未从业'],
  languages: ['中文', '英语', '中文、英语', '日语', '韩语', '法语', '德语', '西班牙语'],
  timezone: ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'],
  pronouns: ['她 / her', '他 / him', 'TA / they', '使用名字', '不愿透露'],
};
const opt = (value, label = value) => ({ value: String(value), label: String(label) });
const list = values => values.map(value => opt(value));
const custom = () => opt('custom', '其他 / 自定义');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const meaningful = value => typeof value === 'string' && value.trim() && value !== 'custom';
const pad = value => String(value).padStart(2, '0');
function merge(base, overrides) { return { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) }; }
function range(from, to, step = 1) {
  return Array.from({ length: Math.floor((to - from) / step + 0.00001) + 1 }, (_, index) => String(Number((from + index * step).toFixed(3))));
}
function keepValue(options, value) {
  return meaningful(value) && !options.some(option => option.value === value) ? [...options, opt(value, `${value}（原值）`)] : options;
}
function numberValues(key, unit) {
  if (key === 'age') return range(0, 130);
  if (key === 'height') return unit === 'm' ? range(0.5, 2.5, 0.01) : unit === 'mm' ? range(500, 2500, 10) : unit === 'ft' ? range(1, 8, 0.1) : unit === 'in' ? range(12, 100, 0.5) : range(50, 250);
  if (key === 'weight') return unit === '斤' ? range(4, 600) : unit === 'lb' ? range(5, 650) : unit === 'g' ? range(500, 300000, 500) : range(2, 300, 0.5);
  if (key === 'shoeSize') return ['CN', 'KR', 'mm'].includes(unit) ? range(100, 330, 5) : ['JP', 'cm'].includes(unit) ? range(10, 33, 0.5) : ['US男', 'US女', 'US', 'UK'].includes(unit) ? range(1, 18, 0.5) : range(20, 55.5, 0.5);
  return [];
}
function birthdayParts(value, options) {
  if (!value.trim()) return { value, year: '', month: '', day: '', pickerMode: 'structured' };
  try {
    const parsed = parseBirthday(value, options);
    return { value, year: String(parsed.year), month: parsed.month ? String(parsed.month) : '', day: parsed.day ? String(parsed.day) : '', pickerMode: 'structured' };
  } catch { return { value, year: '', month: '', day: '', pickerMode: 'custom', customValue: value }; }
}
function locationParts(value) {
  if (!value.trim()) return { value, country: '', region: '', city: '', pickerMode: 'structured', customValue: '' };
  for (const [country, regions] of Object.entries(PLACES)) {
    for (const [region, cities] of Object.entries(regions)) {
      for (const city of cities) {
        if ([city, `${city}市`, `${region} ${city}`, `${country} ${region} ${city}`, `${country} · ${region} · ${city}`].includes(value.trim())) {
          return { value, country, region, city, pickerMode: 'structured', customValue: '' };
        }
      }
    }
  }
  return { value, country: 'custom', region: '', city: '', pickerMode: 'custom', customValue: value };
}
function measurementParts(key, value) {
  const units = PROFILE_PICKER_UNITS[key];
  if (!value.trim()) return { value: '', unit: units[0], unitCustom: '', customValue: '', pickerMode: 'structured' };
  const expression = /^([^\d]*?)\s*(\d+(?:\.\d+)?)\s*([^\d]*?)$/u.exec(value.trim());
  const rawUnit = expression && (expression[1].trim() || expression[3].trim());
  if (expression && rawUnit && !(expression[1].trim() && expression[3].trim())) {
    const unit = units.find(item => item.toLowerCase() === rawUnit.toLowerCase()) || rawUnit;
    return { value: expression[2], unit, unitCustom: '', customValue: '', pickerMode: 'structured' };
  }
  return { value, unit: '', unitCustom: '', customValue: value, pickerMode: 'custom' };
}

/** Empty/incomplete structured selections deliberately have no composed value. */
export function composeProfilePickerValue(key, controls, options = {}) {
  const c = controls || {}, value = String(c.value ?? '').trim();
  if (key === 'birthday') {
    if (c.pickerMode === 'custom') return String(c.customValue ?? value).trim();
    if (!/^\d{4}$/.test(String(c.year || '')) || !/^\d{1,2}$/.test(String(c.month || '')) || !/^\d{1,2}$/.test(String(c.day || ''))) return '';
    const composed = `${c.year}-${pad(c.month)}-${pad(c.day)}`;
    try { return parseBirthday(composed, options).value; } catch { return ''; }
  }
  if (key === 'location') {
    if (c.pickerMode === 'custom' || c.country === 'custom') return String(c.customValue ?? '').trim();
    if (!meaningful(c.country) || !meaningful(c.region) || !meaningful(c.city)) return '';
    return `${c.country.trim()} · ${c.region.trim()} · ${c.city.trim()}`;
  }
  if (key === 'age') return value === 'custom' ? String(c.customValue ?? '').trim() : value;
  if (own(CHOICES, key)) return value === 'custom' ? String(c.customValue ?? '').trim() : value;
  if (own(PROFILE_PICKER_UNITS, key)) {
    if (c.pickerMode === 'custom' && value !== 'custom') return value;
    const number = value === 'custom' ? String(c.customValue ?? '').trim() : value;
    const unit = String(c.unit === 'custom' ? c.unitCustom ?? '' : c.unit ?? '').trim();
    if (!number || !unit) return '';
    // Preserve a legacy composite/free-form value, never append another unit.
    if (!/^\+?\d+(?:\.\d+)?$/.test(number)) return number;
    return key === 'shoeSize' ? `${unit} ${number}` : `${number} ${unit}`;
  }
  return value;
}

/** Pure dependency reset; no UI, memory writes, defaults, or unit conversion. */
export function updateProfilePickerControls(key, controls, changedName) {
  const next = { ...controls };
  if (key === 'birthday' && ['year', 'month', 'day'].includes(changedName)) {
    next.pickerMode = 'structured';
    if (next.day && next.year && next.month) {
      const days = new Date(Date.UTC(Number(next.year), Number(next.month), 0)).getUTCDate();
      if (Number(next.day) > days) next.day = '';
    }
  }
  if (key === 'location') {
    if (changedName === 'country') { next.region = ''; next.city = ''; next.customValue = next.country === 'custom' ? next.customValue || next.value || '' : ''; next.pickerMode = next.country === 'custom' ? 'custom' : 'structured'; }
    if (changedName === 'region') next.city = '';
  }
  if (key === 'birthday' && changedName === 'pickerMode' && next.pickerMode === 'custom' && !next.customValue) next.customValue = next.value || '';
  if (own(PROFILE_PICKER_UNITS, key) && ['value', 'unit'].includes(changedName)
    && (next.value === 'custom' || /^\+?\d+(?:\.\d+)?$/.test(String(next.value || '')))) next.pickerMode = 'structured';
  if (key === 'shoeSize' && changedName === 'unit') { next.value = ''; next.customValue = ''; next.pickerMode = 'structured'; }
  return next;
}

export function getProfilePickerState(key, rawValue = '', overrides = {}, options = {}) {
  const value = String(rawValue ?? '');
  let mode = null, controls = { value }, choices = {};
  if (key === 'birthday') {
    mode = 'birthday'; controls = merge(birthdayParts(value, options), overrides);
    const today = userToday(options), year = Number(controls.year), month = Number(controls.month);
    const maxDay = year && month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 31;
    choices = {
      years: keepValue(list(range(Math.max(1, today.year - 130), today.year).reverse()), controls.year),
      months: list(range(1, 12)), days: list(range(1, maxDay)),
    };
  } else if (key === 'location') {
    mode = 'location'; controls = merge(locationParts(value), overrides);
    choices = {
      countries: [...list(Object.keys(PLACES)), custom()],
      regions: keepValue(list(Object.keys(PLACES[controls.country] || {})), controls.region),
      cities: keepValue(list(PLACES[controls.country]?.[controls.region] || []), controls.city),
    };
  } else if (own(PROFILE_PICKER_UNITS, key)) {
    mode = 'measurement'; controls = merge(measurementParts(key, value), overrides);
    if (overrides.pickerMode === undefined && meaningful(overrides.unit) && /^\+?\d+(?:\.\d+)?$/.test(String(controls.value || ''))) controls.pickerMode = 'structured';
    choices = { values: [...keepValue(list(numberValues(key, controls.unit)), controls.value), custom()], units: [...keepValue(list(PROFILE_PICKER_UNITS[key]), controls.unit), custom()] };
  } else if (key === 'age') {
    mode = 'number'; let initial = value;
    try { if (value.trim()) initial = String(validateAge(value)); } catch {}
    controls = merge({ value: initial, customValue: '' }, overrides);
    choices = { values: [...keepValue(list(numberValues(key)), controls.value), custom()] };
  } else if (own(CHOICES, key)) {
    mode = 'choice'; controls = merge({ value, customValue: CHOICES[key].includes(value) ? '' : value }, overrides);
    choices = { values: [...keepValue(list(CHOICES[key]), controls.value), custom()] };
  } else controls = merge(controls, overrides);
  const composedValue = composeProfilePickerValue(key, controls, options);
  return { mode, controls, options: choices, complete: Boolean(composedValue), composedValue };
}
