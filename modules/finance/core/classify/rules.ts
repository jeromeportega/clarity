interface KeywordRule {
  pattern: RegExp;
  category: string;
}

// Rules are ordered from most specific (service/description keywords) to
// least specific (general retailer catch-alls). First match wins.
const KEYWORD_RULES: KeywordRule[] = [
  // Subscriptions — named streaming / SaaS services
  {
    pattern:
      /netflix|spotify|hulu|disney\+|disney plus|apple tv\+|amazon prime|paramount\+|peacock|hbo\b|showtime|youtube premium|tidal|deezer/i,
    category: 'Subscriptions',
  },
  // Groceries — named grocery chains
  {
    pattern:
      /whole foods|trader joe|kroger|safeway|aldi|publix|wegman|fresh market|sprouts/i,
    category: 'Groceries',
  },
  // Dining — restaurants and food-delivery services
  {
    pattern:
      /starbucks|mcdonald|chipotle|domino'?s|pizza hut|burger king|taco bell|subway\b|panera|shake shack|dunkin|doordash|grubhub|uber eats/i,
    category: 'Dining',
  },
  // Transportation — ride-share (not food delivery) and transit
  {
    pattern: /\buber\b(?!\s*eats)|\blyft\b|taxi\b|transit\b|metro\b|bart\b|\bmta\b|amtrak/i,
    category: 'Transportation',
  },
  // Health & Medical
  {
    pattern:
      /walgreen|cvs\b|pharmacy|clinic\b|hospital|dental|medical\b|lab corp|quest diagnostics/i,
    category: 'Health & Medical',
  },
  // Electronics — item-description keywords take priority over retailer name
  {
    pattern:
      /usb-?c? cable|usb hub|\bheadphone|\bkeyboard\b|\blaptop\b|\bmonitor\b|\bcharger\b|\btablet\b|\bkindle\b/i,
    category: 'Electronics',
  },
  // Books & Media — item-description keywords
  {
    pattern: /\bpaperback\b|\bhardcover\b|\bebook\b|\baudible\b|kindle book|\bmagazine\b|\bnovel\b/i,
    category: 'Books & Media',
  },
  // Clothing — item-description keywords and brand names
  {
    pattern:
      /\bclothing\b|\bshirt\b|\bpants\b|\bdress\b|\bshoes?\b|\bnike\b|\badidas\b|\bgap\b|h&m\b|\bzara\b|old navy|uniqlo/i,
    category: 'Clothing',
  },
  // Home Improvement
  {
    pattern: /home depot|lowe'?s\b|hardware store|\blumber\b|\bplumbing\b/i,
    category: 'Home Improvement',
  },
  // Utilities — billed services and ISPs
  {
    pattern: /electric bill|water bill|gas bill|\butility\b|comcast|verizon|at&t|t-mobile|spectrum\b|xfinity/i,
    category: 'Utilities',
  },
  // Housing — rent / mortgage / property
  {
    pattern: /\brent\b|\bmortgage\b|property tax|hoa fee|\blease\b/i,
    category: 'Housing',
  },
  // Travel
  {
    pattern:
      /airline\b|\bflight\b|\bhotel\b|airbnb|vrbo|expedia|booking\.com|marriott|hilton|\bdelta\b|united airlines|southwest/i,
    category: 'Travel',
  },
  // Insurance
  {
    pattern: /insurance\b|geico|progressive\b|allstate|state farm|\baetna\b|\banthemb\b|cigna/i,
    category: 'Insurance',
  },
  // Personal Care
  {
    pattern: /\bsalon\b|\bhaircut\b|\bspa\b|nail salon|beauty supply|\bbarber\b|\bulta\b|sephora/i,
    category: 'Personal Care',
  },
  // Pet Care
  {
    pattern: /petco|petsmart|veterinar|animal hospital|\bchewy\b/i,
    category: 'Pet Care',
  },
  // Education
  {
    pattern: /\btuition\b|\buniversity\b|\bcollege\b|coursera|udemy|khan academy/i,
    category: 'Education',
  },
  // Shopping — general-purpose retailers (catch-all, must stay last)
  {
    pattern: /\bamazon\b|\btarget\b|walmart|ebay\b|etsy\b|best buy|costco|sam'?s club/i,
    category: 'Shopping',
  },
];

export function applyKeywordRules(
  text: string,
): { category: string; keyword: string } | null {
  for (const rule of KEYWORD_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      return { category: rule.category, keyword: m[0] };
    }
  }
  return null;
}
