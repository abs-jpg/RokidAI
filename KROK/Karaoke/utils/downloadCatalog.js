// 首屏曲目摘要来自自建曲库。联网后使用服务器返回的最新曲目。
export const downloadCatalog = [
  ['red-high-heels', '红色高跟鞋', '蔡健雅', '中文'],
  ['father', '父亲', '筷子兄弟', '中文'],
  ['zui-xuan-min-zu-feng', '最炫民族风', '凤凰传奇', '中文'],
  ['dao-xiang', '稻香', '周杰伦', '中文'],
  ['ziyou-zizai', '自由自在', '凤凰传奇', '中文'],
  ['ziyou-feixiang', '自由飞翔', '凤凰传奇', '中文'],
  ['hai-kuo-tian-kong', '海阔天空', 'BEYOND', '中文'],
  ['yue-liang-re-de-huo', '月亮惹的祸', '张宇', '中文'],
  ['wo-huai-nian-de', '我怀念的', '孙燕姿', '中文'],
  ['shape-of-you', 'Shape of You', 'Ed Sheeran', 'English'],
  ['love-story', 'Love Story', 'Taylor Swift', 'English'],
  ['what-makes-you-beautiful', 'What Makes You Beautiful', 'One Direction', 'English'],
  ['way-back-home', 'Way Back Home', 'SHAUN', '한국어'],
  ['ppa-ppa-ppa', '빠빠빠 (Bar Bar Bar)', '크레용팝 (CRAYON POP)', '한국어'],
  ['gangnam-style', 'Gangnam Style (강남스타일)', 'PSY', '한국어']
].map(([id, name, artist, category]) => ({ id, name, artist, category }))
