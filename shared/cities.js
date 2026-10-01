// 常见机房城市坐标表：前端「添加服务器」时的城市自动补全，以及后端把供应商 region 映射到坐标都用它。
// key 保持稳定（被 server/regions.js 引用），新增城市直接往后加即可。

export const CITIES = [
  // 北美
  { key: 'los-angeles', name: 'Los Angeles', zh: '洛杉矶', cc: 'US', lat: 34.0522, lon: -118.2437 },
  { key: 'san-jose', name: 'San Jose', zh: '圣何塞', cc: 'US', lat: 37.3382, lon: -121.8863 },
  { key: 'fremont', name: 'Fremont', zh: '弗里蒙特', cc: 'US', lat: 37.5485, lon: -121.9886 },
  { key: 'san-francisco', name: 'San Francisco', zh: '旧金山', cc: 'US', lat: 37.7749, lon: -122.4194 },
  { key: 'seattle', name: 'Seattle', zh: '西雅图', cc: 'US', lat: 47.6062, lon: -122.3321 },
  { key: 'portland', name: 'Portland', zh: '波特兰', cc: 'US', lat: 45.5152, lon: -122.6784 },
  { key: 'phoenix', name: 'Phoenix', zh: '凤凰城', cc: 'US', lat: 33.4484, lon: -112.074 },
  { key: 'las-vegas', name: 'Las Vegas', zh: '拉斯维加斯', cc: 'US', lat: 36.1699, lon: -115.1398 },
  { key: 'salt-lake-city', name: 'Salt Lake City', zh: '盐湖城', cc: 'US', lat: 40.7608, lon: -111.891 },
  { key: 'denver', name: 'Denver', zh: '丹佛', cc: 'US', lat: 39.7392, lon: -104.9903 },
  { key: 'dallas', name: 'Dallas', zh: '达拉斯', cc: 'US', lat: 32.7767, lon: -96.797 },
  { key: 'kansas-city', name: 'Kansas City', zh: '堪萨斯城', cc: 'US', lat: 39.0997, lon: -94.5786 },
  { key: 'chicago', name: 'Chicago', zh: '芝加哥', cc: 'US', lat: 41.8781, lon: -87.6298 },
  { key: 'atlanta', name: 'Atlanta', zh: '亚特兰大', cc: 'US', lat: 33.749, lon: -84.388 },
  { key: 'miami', name: 'Miami', zh: '迈阿密', cc: 'US', lat: 25.7617, lon: -80.1918 },
  { key: 'ashburn', name: 'Ashburn', zh: '阿什本', cc: 'US', lat: 39.0438, lon: -77.4874 },
  { key: 'washington', name: 'Washington DC', zh: '华盛顿', cc: 'US', lat: 38.9072, lon: -77.0369 },
  { key: 'new-york', name: 'New York', zh: '纽约', cc: 'US', lat: 40.7128, lon: -74.006 },
  { key: 'new-jersey', name: 'Piscataway, NJ', zh: '新泽西', cc: 'US', lat: 40.5546, lon: -74.4643 },
  { key: 'newark', name: 'Newark', zh: '纽瓦克', cc: 'US', lat: 40.7357, lon: -74.1724 },
  { key: 'buffalo', name: 'Buffalo', zh: '布法罗', cc: 'US', lat: 42.8864, lon: -78.8784 },
  { key: 'boston', name: 'Boston', zh: '波士顿', cc: 'US', lat: 42.3601, lon: -71.0589 },
  { key: 'hillsboro', name: 'Hillsboro', zh: '希尔斯伯勒', cc: 'US', lat: 45.5229, lon: -122.9898 },
  { key: 'honolulu', name: 'Honolulu', zh: '檀香山', cc: 'US', lat: 21.3069, lon: -157.8583 },
  { key: 'toronto', name: 'Toronto', zh: '多伦多', cc: 'CA', lat: 43.6532, lon: -79.3832 },
  { key: 'montreal', name: 'Montreal', zh: '蒙特利尔', cc: 'CA', lat: 45.5017, lon: -73.5673 },
  { key: 'vancouver', name: 'Vancouver', zh: '温哥华', cc: 'CA', lat: 49.2827, lon: -123.1207 },
  { key: 'beauharnois', name: 'Beauharnois', zh: '博阿尔努瓦', cc: 'CA', lat: 45.3151, lon: -73.8779 },
  { key: 'mexico-city', name: 'Mexico City', zh: '墨西哥城', cc: 'MX', lat: 19.4326, lon: -99.1332 },
  // 南美
  { key: 'sao-paulo', name: 'São Paulo', zh: '圣保罗', cc: 'BR', lat: -23.5505, lon: -46.6333 },
  { key: 'santiago', name: 'Santiago', zh: '圣地亚哥', cc: 'CL', lat: -33.4489, lon: -70.6693 },
  { key: 'buenos-aires', name: 'Buenos Aires', zh: '布宜诺斯艾利斯', cc: 'AR', lat: -34.6037, lon: -58.3816 },
  { key: 'bogota', name: 'Bogotá', zh: '波哥大', cc: 'CO', lat: 4.711, lon: -74.0721 },
  // 欧洲
  { key: 'london', name: 'London', zh: '伦敦', cc: 'GB', lat: 51.5074, lon: -0.1278 },
  { key: 'manchester', name: 'Manchester', zh: '曼彻斯特', cc: 'GB', lat: 53.4808, lon: -2.2426 },
  { key: 'dublin', name: 'Dublin', zh: '都柏林', cc: 'IE', lat: 53.3498, lon: -6.2603 },
  { key: 'paris', name: 'Paris', zh: '巴黎', cc: 'FR', lat: 48.8566, lon: 2.3522 },
  { key: 'gravelines', name: 'Gravelines', zh: '格拉沃利讷', cc: 'FR', lat: 50.9871, lon: 2.1255 },
  { key: 'roubaix', name: 'Roubaix', zh: '鲁贝', cc: 'FR', lat: 50.6942, lon: 3.1746 },
  { key: 'strasbourg', name: 'Strasbourg', zh: '斯特拉斯堡', cc: 'FR', lat: 48.5734, lon: 7.7521 },
  { key: 'amsterdam', name: 'Amsterdam', zh: '阿姆斯特丹', cc: 'NL', lat: 52.3676, lon: 4.9041 },
  { key: 'brussels', name: 'Brussels', zh: '布鲁塞尔', cc: 'BE', lat: 50.8503, lon: 4.3517 },
  { key: 'frankfurt', name: 'Frankfurt', zh: '法兰克福', cc: 'DE', lat: 50.1109, lon: 8.6821 },
  { key: 'falkenstein', name: 'Falkenstein', zh: '法尔肯施泰因', cc: 'DE', lat: 50.4777, lon: 12.3649 },
  { key: 'nuremberg', name: 'Nuremberg', zh: '纽伦堡', cc: 'DE', lat: 49.4521, lon: 11.0767 },
  { key: 'berlin', name: 'Berlin', zh: '柏林', cc: 'DE', lat: 52.52, lon: 13.405 },
  { key: 'dusseldorf', name: 'Düsseldorf', zh: '杜塞尔多夫', cc: 'DE', lat: 51.2277, lon: 6.7735 },
  { key: 'zurich', name: 'Zurich', zh: '苏黎世', cc: 'CH', lat: 47.3769, lon: 8.5417 },
  { key: 'vienna', name: 'Vienna', zh: '维也纳', cc: 'AT', lat: 48.2082, lon: 16.3738 },
  { key: 'milan', name: 'Milan', zh: '米兰', cc: 'IT', lat: 45.4642, lon: 9.19 },
  { key: 'madrid', name: 'Madrid', zh: '马德里', cc: 'ES', lat: 40.4168, lon: -3.7038 },
  { key: 'lisbon', name: 'Lisbon', zh: '里斯本', cc: 'PT', lat: 38.7223, lon: -9.1393 },
  { key: 'stockholm', name: 'Stockholm', zh: '斯德哥尔摩', cc: 'SE', lat: 59.3293, lon: 18.0686 },
  { key: 'oslo', name: 'Oslo', zh: '奥斯陆', cc: 'NO', lat: 59.9139, lon: 10.7522 },
  { key: 'copenhagen', name: 'Copenhagen', zh: '哥本哈根', cc: 'DK', lat: 55.6761, lon: 12.5683 },
  { key: 'helsinki', name: 'Helsinki', zh: '赫尔辛基', cc: 'FI', lat: 60.1699, lon: 24.9384 },
  { key: 'warsaw', name: 'Warsaw', zh: '华沙', cc: 'PL', lat: 52.2297, lon: 21.0122 },
  { key: 'prague', name: 'Prague', zh: '布拉格', cc: 'CZ', lat: 50.0755, lon: 14.4378 },
  { key: 'bucharest', name: 'Bucharest', zh: '布加勒斯特', cc: 'RO', lat: 44.4268, lon: 26.1025 },
  { key: 'sofia', name: 'Sofia', zh: '索非亚', cc: 'BG', lat: 42.6977, lon: 23.3219 },
  { key: 'istanbul', name: 'Istanbul', zh: '伊斯坦布尔', cc: 'TR', lat: 41.0082, lon: 28.9784 },
  { key: 'moscow', name: 'Moscow', zh: '莫斯科', cc: 'RU', lat: 55.7558, lon: 37.6173 },
  { key: 'kyiv', name: 'Kyiv', zh: '基辅', cc: 'UA', lat: 50.4501, lon: 30.5234 },
  // 中东 / 非洲
  { key: 'tel-aviv', name: 'Tel Aviv', zh: '特拉维夫', cc: 'IL', lat: 32.0853, lon: 34.7818 },
  { key: 'dubai', name: 'Dubai', zh: '迪拜', cc: 'AE', lat: 25.2048, lon: 55.2708 },
  { key: 'bahrain', name: 'Manama', zh: '巴林', cc: 'BH', lat: 26.2285, lon: 50.586 },
  { key: 'riyadh', name: 'Riyadh', zh: '利雅得', cc: 'SA', lat: 24.7136, lon: 46.6753 },
  { key: 'johannesburg', name: 'Johannesburg', zh: '约翰内斯堡', cc: 'ZA', lat: -26.2041, lon: 28.0473 },
  { key: 'cape-town', name: 'Cape Town', zh: '开普敦', cc: 'ZA', lat: -33.9249, lon: 18.4241 },
  { key: 'lagos', name: 'Lagos', zh: '拉各斯', cc: 'NG', lat: 6.5244, lon: 3.3792 },
  { key: 'cairo', name: 'Cairo', zh: '开罗', cc: 'EG', lat: 30.0444, lon: 31.2357 },
  { key: 'nairobi', name: 'Nairobi', zh: '内罗毕', cc: 'KE', lat: -1.2921, lon: 36.8219 },
  // 亚洲
  { key: 'hong-kong', name: 'Hong Kong', zh: '香港', cc: 'HK', lat: 22.3193, lon: 114.1694 },
  { key: 'taipei', name: 'Taipei', zh: '台北', cc: 'TW', lat: 25.033, lon: 121.5654 },
  { key: 'changhua', name: 'Changhua', zh: '彰化', cc: 'TW', lat: 24.0518, lon: 120.5161 },
  { key: 'tokyo', name: 'Tokyo', zh: '东京', cc: 'JP', lat: 35.6762, lon: 139.6503 },
  { key: 'osaka', name: 'Osaka', zh: '大阪', cc: 'JP', lat: 34.6937, lon: 135.5023 },
  { key: 'seoul', name: 'Seoul', zh: '首尔', cc: 'KR', lat: 37.5665, lon: 126.978 },
  { key: 'chuncheon', name: 'Chuncheon', zh: '春川', cc: 'KR', lat: 37.8813, lon: 127.7298 },
  { key: 'singapore', name: 'Singapore', zh: '新加坡', cc: 'SG', lat: 1.3521, lon: 103.8198 },
  { key: 'kuala-lumpur', name: 'Kuala Lumpur', zh: '吉隆坡', cc: 'MY', lat: 3.139, lon: 101.6869 },
  { key: 'bangkok', name: 'Bangkok', zh: '曼谷', cc: 'TH', lat: 13.7563, lon: 100.5018 },
  { key: 'ho-chi-minh', name: 'Ho Chi Minh City', zh: '胡志明市', cc: 'VN', lat: 10.8231, lon: 106.6297 },
  { key: 'hanoi', name: 'Hanoi', zh: '河内', cc: 'VN', lat: 21.0278, lon: 105.8342 },
  { key: 'manila', name: 'Manila', zh: '马尼拉', cc: 'PH', lat: 14.5995, lon: 120.9842 },
  { key: 'jakarta', name: 'Jakarta', zh: '雅加达', cc: 'ID', lat: -6.2088, lon: 106.8456 },
  { key: 'mumbai', name: 'Mumbai', zh: '孟买', cc: 'IN', lat: 19.076, lon: 72.8777 },
  { key: 'delhi', name: 'Delhi', zh: '德里', cc: 'IN', lat: 28.7041, lon: 77.1025 },
  { key: 'bangalore', name: 'Bangalore', zh: '班加罗尔', cc: 'IN', lat: 12.9716, lon: 77.5946 },
  { key: 'chennai', name: 'Chennai', zh: '金奈', cc: 'IN', lat: 13.0827, lon: 80.2707 },
  { key: 'hyderabad', name: 'Hyderabad', zh: '海得拉巴', cc: 'IN', lat: 17.385, lon: 78.4867 },
  { key: 'karachi', name: 'Karachi', zh: '卡拉奇', cc: 'PK', lat: 24.8607, lon: 67.0011 },
  { key: 'almaty', name: 'Almaty', zh: '阿拉木图', cc: 'KZ', lat: 43.222, lon: 76.8512 },
  { key: 'beijing', name: 'Beijing', zh: '北京', cc: 'CN', lat: 39.9042, lon: 116.4074 },
  { key: 'shanghai', name: 'Shanghai', zh: '上海', cc: 'CN', lat: 31.2304, lon: 121.4737 },
  { key: 'guangzhou', name: 'Guangzhou', zh: '广州', cc: 'CN', lat: 23.1291, lon: 113.2644 },
  { key: 'shenzhen', name: 'Shenzhen', zh: '深圳', cc: 'CN', lat: 22.5431, lon: 114.0579 },
  { key: 'hangzhou', name: 'Hangzhou', zh: '杭州', cc: 'CN', lat: 30.2741, lon: 120.1551 },
  { key: 'chengdu', name: 'Chengdu', zh: '成都', cc: 'CN', lat: 30.5728, lon: 104.0668 },
  { key: 'qingdao', name: 'Qingdao', zh: '青岛', cc: 'CN', lat: 36.0671, lon: 120.3826 },
  { key: 'zhangjiakou', name: 'Zhangjiakou', zh: '张家口', cc: 'CN', lat: 40.8244, lon: 114.8875 },
  { key: 'wuhan', name: 'Wuhan', zh: '武汉', cc: 'CN', lat: 30.5928, lon: 114.3055 },
  { key: 'nanjing', name: 'Nanjing', zh: '南京', cc: 'CN', lat: 32.0603, lon: 118.7969 },
  { key: 'macau', name: 'Macau', zh: '澳门', cc: 'MO', lat: 22.1987, lon: 113.5439 },
  // 大洋洲
  { key: 'sydney', name: 'Sydney', zh: '悉尼', cc: 'AU', lat: -33.8688, lon: 151.2093 },
  { key: 'melbourne', name: 'Melbourne', zh: '墨尔本', cc: 'AU', lat: -37.8136, lon: 144.9631 },
  { key: 'perth', name: 'Perth', zh: '珀斯', cc: 'AU', lat: -31.9505, lon: 115.8605 },
  { key: 'brisbane', name: 'Brisbane', zh: '布里斯班', cc: 'AU', lat: -27.4698, lon: 153.0251 },
  { key: 'auckland', name: 'Auckland', zh: '奥克兰', cc: 'NZ', lat: -36.8485, lon: 174.7633 },
];

export const CITY_BY_KEY = Object.fromEntries(CITIES.map((c) => [c.key, c]));

/** 模糊查找城市：匹配 key / 英文名 / 中文名 */
export function findCity(query) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  if (CITY_BY_KEY[q]) return CITY_BY_KEY[q];
  return (
    CITIES.find((c) => c.name.toLowerCase() === q || c.zh === q) ||
    CITIES.find((c) => c.name.toLowerCase().includes(q) || c.zh.includes(q) || q.includes(c.name.toLowerCase())) ||
    null
  );
}

/** 两点大圆距离（km） */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 按光纤传播粗略估算 RTT（ms）：光纤 ~200km/ms，实际路由绕行系数取 1.6 */
export function estimateRttMs(a, b) {
  const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
  return Math.round(((km * 1.6) / 200) * 2 + 2);
}
