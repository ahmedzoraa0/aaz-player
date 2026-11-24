/**
 * AZ0 Theme Studio Catalog — 16 Distinct Green-Identity Visual Themes (Dark + Light = 32 Modes).
 * Every theme keeps AZ0's signature green primary brand identity while dramatically transforming
 * surface materials, supporting accent palettes, box geometry, borders, shadows, controls & typography.
 */

export const DEFAULT_SKIN = 'foliage';
export const SKIN_STORAGE_KEY = 'aaz_skin';

export const SKINS = Object.freeze([
  Object.freeze({
    id: 'foliage',
    nameEn: 'Foliage Studio',
    nameAr: 'استوديو فولييج (الافتراضي)',
    descEn: 'Signature balanced studio panels, crisp hairline borders & Plus Jakarta Sans',
    descAr: 'تصميم الاستوديو الأصلي المتوازن بحواف ناعمة وحدود دقيقة',
    tagEn: 'Default',
    tagAr: 'الافتراضي',
  }),
  Object.freeze({
    id: 'minecraft',
    nameEn: 'Minecraft Craft',
    nameAr: 'ماينكرافت (بلوكات)',
    descEn: 'Grass-block trim, cobblestone 3D beveled slots, XP-bar scrubber & blocky pixel UI',
    descAr: 'شريط عشب أخضر ومربعات حجرية بارزة وشريط خبرة بطابع ماينكرافت',
    tagEn: 'Voxel Game',
    tagAr: 'ألعاب',
  }),
  Object.freeze({
    id: 'lego',
    nameEn: 'LEGO Brick',
    nameAr: 'ليجو (مكعبات)',
    descEn: 'Glossy clickable 3D bricks, circular stud textures, green baseplate & classic brick accents',
    descAr: 'مكعبات لامعة ثلاثية الأبعاد بنقشة دوائر الليجو وألوان المكعبات الكلاسيكية',
    tagEn: 'Toy Brick',
    tagAr: 'مكعبات',
  }),
  Object.freeze({
    id: 'roblox',
    nameEn: 'Roblox Studio',
    nameAr: 'روبلوكس ستوديو',
    descEn: 'Clean Studio charcoal & crisp white blocks, bold emerald Play button & cobalt accents',
    descAr: 'واجهة ستوديو عصرية بكتل واضحة وزر تشغيل أخضر بارز ولمسات زرقاء',
    tagEn: 'Blox UI',
    tagAr: 'ألعاب',
  }),
  Object.freeze({
    id: 'mario',
    nameEn: 'Super Arcade 16-Bit',
    nameAr: 'سوبر أركيد 16-Bit',
    descEn: 'Glossy cartridge buttons, pipe-green hero controls, coin-gold & castle-sky accents',
    descAr: 'أزرار ألعاب كلاسيكية لامعة بلون الأنابيب الأخضر ولمسات ذهبية وحمراء',
    tagEn: '16-Bit',
    tagAr: 'كلاسيك',
  }),
  Object.freeze({
    id: 'retro95',
    nameEn: 'Classic OS 95',
    nameAr: 'كمبيوتر كلاسيك 95',
    descEn: 'Authentic 95 teal desktop, silver-gray 3D raised/sunken bevels, green titlebars & Tahoma',
    descAr: 'سطح مكتب تسعينياتي حقيقي بنوافذ رمادية ثلاثية الأبعاد وحواف حادة',
    tagEn: 'Classic OS',
    tagAr: 'ويندوز 95',
  }),
  Object.freeze({
    id: 'arcade',
    nameEn: 'Game Boy LCD',
    nameAr: 'جيم بوي كلاسيك',
    descEn: '4-shade olive dot-matrix LCD screen in Light Mode & neon arcade cabinet in Dark Mode',
    descAr: 'شاشة جيم بوي خضراء زيتونية بنقط الشاشة في الفاتح وخزانة أركيد في الداكن',
    tagEn: 'Handheld',
    tagAr: 'أركيد',
  }),
  Object.freeze({
    id: 'terminal',
    nameEn: 'Phosphor CRT',
    nameAr: 'شاشة تيرمينال CRT',
    descEn: 'Glowing phosphor CRT monitor with scanlines in Dark Mode & green-bar ledger paper in Light',
    descAr: 'شاشة تيرمينال فوسفورية مضيئة بخطوط المسح في الداكن وورق طابعة قديم في الفاتح',
    tagEn: 'CRT Tech',
    tagAr: 'تيرمينال',
  }),
  Object.freeze({
    id: 'cyber',
    nameEn: 'Cyber Tactical HUD',
    nameAr: 'سايبر ألعاب مستقبلي',
    descEn: '45° chamfered armor corners, obsidian-navy cockpit, laser emerald & cyan HUD trim',
    descAr: 'زوايا تكتيكية مقطوعة بزاوية 45 درجة مع إضاءة خضراء وسماوية مستقبلية',
    tagEn: 'Sci-Fi HUD',
    tagAr: 'مستقبلي',
  }),
  Object.freeze({
    id: 'brutalist',
    nameEn: 'Neo-Brutalist Pop',
    nameAr: 'بروتاليزم جريء',
    descEn: 'Bold warm poster cream, thick 3px ink frames, hard 5px shadows, green & acid-yellow pop',
    descAr: 'حدود سوداء سميكة وظلال صلبة بارزة مع تباين قوي ولمسات خضراء وصفراء',
    tagEn: 'Bold Pop',
    tagAr: 'جريء',
  }),
  Object.freeze({
    id: 'hifi',
    nameEn: 'Hi-Fi Stereo Deck',
    nameAr: 'جهاز استوديو Hi-Fi',
    descEn: 'Brushed silver/gunmetal faceplate, walnut-brass trim, recessed green LCD & rotary dial',
    descAr: 'واجهة معدنية مصقولة وإطار خشبي نحاسي وشاشة عرض خضراء غائرة',
    tagEn: 'Hardware',
    tagAr: 'صوتيات',
  }),
  Object.freeze({
    id: 'glass',
    nameEn: 'Aurora Frosted Glass',
    nameAr: 'زجاجي ضبابي أورورا',
    descEn: 'Translucent blurred acrylic panels floating over a luminous emerald-teal aurora backdrop',
    descAr: 'ألواح زجاجية ضبابية شفافة تطفو فوق خلفية أورورا خضراء وزرقاء متوهجة',
    tagEn: 'Frosted',
    tagAr: 'زجاجي',
  }),
  Object.freeze({
    id: 'editorial',
    nameEn: 'Royal Forest Editorial',
    nameAr: 'كلاسيك ملكي فاخر',
    descEn: 'Ivory parchment & velvet forest green, antique gold double borders & Georgia serif type',
    descAr: 'ورق عاجي وأخضر ملكي غامق بإطارات ذهبية مزدوجة وخط كلاسيكي فاخر',
    tagEn: 'Luxury',
    tagAr: 'فاخر',
  }),
  Object.freeze({
    id: 'clay',
    nameEn: 'Soft Toy Clay 3D',
    nameAr: 'صلصال ناعم ثلاثي الأبعاد',
    descEn: 'Puffy 3D pillow buttons with glossy top highlights, plush curves & warm coral accents',
    descAr: 'أزرار منفوخة ناعمة ثلاثية الأبعاد بإضاءة لامعة وحواف دائرية مريحة',
    tagEn: 'Clay 3D',
    tagAr: 'مجسّم',
  }),
  Object.freeze({
    id: 'blueprint',
    nameEn: 'CAD Blueprint',
    nameAr: 'مخطط هندسي CAD',
    descEn: 'Authentic architectural blueprint blue grid, dashed drafting rules & vibrant emerald controls',
    descAr: 'ورق مخططات هندسية أزرق بشبكة إحداثيات دقيقة وأزرار خضراء واضحة',
    tagEn: 'Drafting',
    tagAr: 'هندسي',
  }),
  Object.freeze({
    id: 'pebble',
    nameEn: 'Botanical Pebble',
    nameAr: 'طبيعي انسيابي',
    descEn: 'Warm sandstone-linen surfaces, full-capsule pill controls, moss green & terracotta accents',
    descAr: 'خلفية رملية دافئة وأزرار كبسولية دائرية بالكامل مع أخضر طبيعي ولمسات دافئة',
    tagEn: 'Organic',
    tagAr: 'انسيابي',
  }),
]);

export const SKIN_IDS = new Set(SKINS.map((s) => s.id));

export function isValidSkin(skinId) {
  return typeof skinId === 'string' && SKIN_IDS.has(skinId);
}

export function sanitizeSkin(skinId) {
  return isValidSkin(skinId) ? skinId : DEFAULT_SKIN;
}

export function getSkinMeta(skinId) {
  const id = sanitizeSkin(skinId);
  return SKINS.find((s) => s.id === id) || SKINS[0];
}
