// 供应商 region 代码 → shared/cities.js 中的城市 key。
// 找不到映射时，导入流程会退回到 IP 地理定位（server/geoip.js）。
import { CITY_BY_KEY, findCity } from '../shared/cities.js';

const REGION_MAP = {
  vultr: {
    ewr: 'new-jersey', ord: 'chicago', dfw: 'dallas', sea: 'seattle', lax: 'los-angeles', atl: 'atlanta',
    ams: 'amsterdam', lhr: 'london', fra: 'frankfurt', sjc: 'san-jose', syd: 'sydney', yto: 'toronto',
    cdg: 'paris', nrt: 'tokyo', icn: 'seoul', mia: 'miami', sgp: 'singapore', sto: 'stockholm',
    mex: 'mexico-city', mad: 'madrid', sao: 'sao-paulo', del: 'delhi', hnl: 'honolulu', waw: 'warsaw',
    bom: 'mumbai', jnb: 'johannesburg', mel: 'melbourne', blr: 'bangalore', itm: 'osaka', scl: 'santiago',
    tlv: 'tel-aviv', man: 'manchester',
  },
  digitalocean: {
    nyc1: 'new-york', nyc2: 'new-york', nyc3: 'new-york', sfo1: 'san-francisco', sfo2: 'san-francisco',
    sfo3: 'san-francisco', ams2: 'amsterdam', ams3: 'amsterdam', sgp1: 'singapore', lon1: 'london',
    fra1: 'frankfurt', tor1: 'toronto', blr1: 'bangalore', syd1: 'sydney', atl1: 'atlanta',
  },
  linode: {
    'us-east': 'newark', 'us-central': 'dallas', 'us-west': 'fremont', 'us-southeast': 'atlanta',
    'ca-central': 'toronto', 'eu-west': 'london', 'eu-central': 'frankfurt', 'ap-south': 'singapore',
    'ap-northeast': 'tokyo', 'ap-west': 'mumbai', 'ap-southeast': 'sydney', 'us-iad': 'washington',
    'us-ord': 'chicago', 'fr-par': 'paris', 'us-sea': 'seattle', 'br-gru': 'sao-paulo', 'nl-ams': 'amsterdam',
    'se-sto': 'stockholm', 'es-mad': 'madrid', 'in-maa': 'chennai', 'jp-osa': 'osaka', 'it-mil': 'milan',
    'us-mia': 'miami', 'id-cgk': 'jakarta', 'us-lax': 'los-angeles', 'gb-lon': 'london', 'au-mel': 'melbourne',
    'in-bom-2': 'mumbai', 'de-fra-2': 'frankfurt', 'sg-sin-2': 'singapore', 'jp-tyo-3': 'tokyo',
  },
  hetzner: {
    fsn1: 'falkenstein', nbg1: 'nuremberg', hel1: 'helsinki', ash: 'ashburn', hil: 'hillsboro', sin: 'singapore',
  },
};

// 搬瓦工 node_location_id 前缀（例：USCA_6、JPOS_1、HK_85）
const BWH_PREFIX = [
  ['USCA_FMT', 'fremont'], ['USCA', 'los-angeles'], ['USNJ', 'new-jersey'], ['USNY', 'new-york'],
  ['USAZ', 'phoenix'], ['USFL', 'miami'], ['CABC', 'vancouver'], ['JPOS', 'osaka'], ['JPTK', 'tokyo'],
  ['JPTYO', 'tokyo'], ['HK', 'hong-kong'], ['NLAM', 'amsterdam'], ['EUNL', 'amsterdam'], ['AE', 'dubai'],
  ['SG', 'singapore'], ['GB', 'london'], ['UK', 'london'], ['FR', 'paris'], ['DE', 'frankfurt'],
];

export function cityFromRegion(provider, region) {
  if (!region) return null;
  const r = String(region).toLowerCase();
  if (provider === 'bandwagon') {
    const up = String(region).toUpperCase();
    const hit = BWH_PREFIX.find(([p]) => up.startsWith(p));
    return hit ? CITY_BY_KEY[hit[1]] : null;
  }
  const key = REGION_MAP[provider]?.[r];
  if (key) return CITY_BY_KEY[key];
  // 兜底：region 本身就是城市名（例如自定义 JSON 里写 "Los Angeles"）
  return findCity(region);
}
