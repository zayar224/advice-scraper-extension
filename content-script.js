// Guard against duplicate injection (manifest + scripting.executeScript both inject this file).
if (window._adviceScraperLoaded) {
  console.log("[Advice Scraper] Already loaded, skipping duplicate injection");
} else {
window._adviceScraperLoaded = true;
(function() {
function U(e){
  // Normalize HTML entities: &#3647; (decimal), &#x0E3F; (hex), literal ฿
  const normalized=e
    .replace(/&#(\d+);?/g,(_,d)=>String.fromCharCode(parseInt(d,10)))
    .replace(/&#x([0-9a-fA-F]+);?/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
    .replace(/[๐๑๒๓๔๕๖๗๘๙]/g, m => '๐๑๒๓๔๕๖๗๘๙'.indexOf(m))
    .replace(/฿/g,'')
    .replace(/,/g,'')
    .trim();
  const r=normalized.match(/\d+/);
  return r?parseInt(r[0],10):null;
}

// Robust price extraction — tries multiple patterns to handle HTML-encoded baht symbols.
function extractPrice(text){
  if(!text)return null;
  console.log('[extractPrice] input text length:', text.length, 'first 200 chars:', text.slice(0,200));
  // Strategy: normalize the text first (convert HTML entities to literal ฿), then scan.
  // This way we only need one pattern matching approach.
  const normalized=text
    .replace(/&#(\d+);?/g,(_,d)=>{
      const cp=parseInt(d,10);
      return cp===3647?'฿':String.fromCharCode(cp);
    })
    .replace(/&#x0*E3F;?/gi,'฿')
    .replace(/&#x([0-9a-fA-F]+);?/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
  console.log('[extractPrice] normalized first 200:', normalized.slice(0,200));

  // Now find all ฿ occurrences with their following numbers.
  const matches=[];
  const bahtRe=/฿\s*([\d,]+)/g;
  let m;
  while((m=bahtRe.exec(normalized))!==null){
    const before=normalized.slice(Math.max(0,m.index-2),m.index);
    // Skip the discount line (-฿1,500 style)
    if(before.includes("-")||before.includes("−"))continue;
    matches.push(m[1]); // just the number part
  }
  console.log('[extractPrice] matches found:', matches);
  if(matches.length===0){
    console.log('[extractPrice] NO MATCHES - trying fallback pattern');
    // Fallback: look for plain numbers that might be prices (with Thai text "บาท" or "บาท")
    const fallbackRe=/(\d[\d,]*)\s*(?:บาท|THB|฿)/g;
    const fallbackMatches=[];
    let fm;
    while((fm=fallbackRe.exec(normalized))!==null){
      fallbackMatches.push(fm[1]);
    }
    console.log('[extractPrice] fallback matches:', fallbackMatches);
    if(fallbackMatches.length>0){
      const last=fallbackMatches[fallbackMatches.length-1];
      return{str:'฿'+last,val:U('฿'+last)};
    }
    return null;
  }
  const last=matches[matches.length-1];
  return{str:'฿'+last,val:U('฿'+last)};
}

// ─── Text cleaning utilities ─────────────────────────────────────────────
function stripThai(text){
  if(!text)return '';
  return text.replace(/[\u0E00-\u0E7F]+/g,' ').replace(/\s+/g,' ').trim();
}
function hasThai(text){
  return /[\u0E00-\u0E7F]/.test(text);
}
function isMostlyEnglish(text){
  if(!text)return false;
  const latin=(text.match(/[a-zA-Z0-9]/g)||[]).length;
  return latin/Math.max(text.length,1)>0.4;
}
function cleanHtmlEntities(text){
  if(!text)return '';
  return text
    .replace(/<[^>]*>/g,'')
    .replace(/&nbsp;/gi,' ')
    .replace(/&reg;/gi,'®')
    .replace(/&trade;/gi,'™')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"')
    .replace(/&#(\d+);?/g,(_,d)=>String.fromCharCode(parseInt(d,10)))
    .replace(/&#x([0-9a-fA-F]+);?/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
    .replace(/\\u003C[^>]*>/g,'')
    .replace(/\\/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
function isGarbageSpecValue(value){
  if(!value)return true;
  if(value.includes('{')&&value.includes('}'))return true;
  if(value.includes('\\u003C'))return true;
  if(value.includes('[{')||value.includes('}]'))return true;
  if(value.includes('"title"')||value.includes('"value"')||value.includes('"data"')||value.includes('"data_eng"'))return true;
  if(value.startsWith(',')||value.startsWith('"'))return true;
  if(value.length>300&&value.includes(','))return true;
  return false;
}
function isGarbageSpecKey(key){
  if(!key)return true;
  const skip=[
    'compare','add to','payment','installment details','free gift',
    'show','view more','wishlist','share','cart','buy',
    'easy payment','warranty terms','choose your'
  ];
  const kl=key.toLowerCase().trim();
  if(skip.some(s=>kl.startsWith(s)))return true;
  if(kl.length<2)return true;
  return false;
}

// ─── NUXT_DATA parser for specs ─────────────────────────────────────────
// advice.co.th stores specs in a script#__NUXT_DATA__ JSON blob, NOT in the DOM.
// This parses that indexed array format and extracts English specs.
function parseNuxtSpecs(doc){
  try{
    const scriptEl=doc.querySelector('script#__NUXT_DATA__');
    if(!scriptEl)return[];
    const raw=scriptEl.textContent;
    if(!raw)return[];
    const arr=JSON.parse(raw);
    if(!Array.isArray(arr)||arr.length<10)return[];

    // Helper: resolve an index reference to its actual value
    function resolve(idx){
      if(typeof idx!=='number'||idx<0||idx>=arr.length)return'';
      const v=arr[idx];
      if(v===null||v===undefined)return'';
      if(typeof v==='string')return v;
      if(typeof v==='number'||typeof v==='boolean')return String(v);
      return'';
    }

    // Helper: resolve an HTML-wrapped value (strip <p>, &nbsp;, etc.)
    function resolveHtml(idx){
      let s=resolve(idx);
      if(!s)return'';
      // Strip HTML tags
      s=s.replace(/<[^>]*>/g,'');
      // Decode common HTML entities
      s=s.replace(/&nbsp;/gi,' ').replace(/&reg;/gi,'®').replace(/&trade;/gi,'™')
         .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
         .replace(/&quot;/gi,'"').replace(/&#(\d+);?/g,(_,d)=>String.fromCharCode(parseInt(d,10)))
         .replace(/&#x([0-9a-fA-F]+);?/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
      return s.replace(/\s+/g,' ').trim();
    }

    // Find the product object in the array — look for one that has "spec_detail"
    let productIdx=-1;
    for(let i=0;i<Math.min(arr.length,50);i++){
      if(arr[i]&&typeof arr[i]==='object'&&!Array.isArray(arr[i])){
        const keys=Object.keys(arr[i]);
        if(keys.includes('spec_detail')||keys.includes('spec')){
          productIdx=i;
          break;
        }
      }
    }
    if(productIdx<0)return[];

    const product=arr[productIdx];
    const specDetailIdx=product.spec_detail;
    if(typeof specDetailIdx!=='number')return[];
    const specDetail=arr[specDetailIdx];
    if(!Array.isArray(specDetail))return[];

    const rows=[];
    const seenKeys=new Set();

    // Each element in specDetail is a category object index
    for(const catIdx of specDetail){
      const cat=arr[catIdx];
      if(!cat||typeof cat!=='object')continue;

      // Prefer data_eng (English) over data (current language)
      let itemsIdx=cat.data_eng||cat.data;
      if(typeof itemsIdx!=='number')continue;
      const items=arr[itemsIdx];
      if(!Array.isArray(items))continue;

      for(const itemIdx of items){
        const item=arr[itemIdx];
        if(!item||typeof item!=='object')continue;
        const title=resolve(item.title);
        let value=resolveHtml(item.value);
        if(!title||!value)continue;
        // Clean Thai from value
        value=stripThai(value);
        if(!value)continue;
        const normKey=title.toLowerCase().trim();
        if(seenKeys.has(normKey))continue;
        seenKeys.add(normKey);
        rows.push({key:title.trim(),value});
      }
    }
    return rows;
  }catch(e){
    console.warn('[scraper] parseNuxtSpecs error:',e);
    return[];
  }
}

// Also extract product name, model, brand from NUXT data
function parseNuxtProductInfo(doc){
  try{
    const scriptEl=doc.querySelector('script#__NUXT_DATA__');
    if(!scriptEl)return null;
    const arr=JSON.parse(scriptEl.textContent);
    if(!Array.isArray(arr)||arr.length<10)return null;

    function resolve(idx){
      if(typeof idx!=='number'||idx<0||idx>=arr.length)return'';
      const v=arr[idx];
      if(typeof v==='string')return v;
      if(typeof v==='number'||typeof v==='boolean')return String(v);
      return'';
    }

    // Find product object
    let productIdx=-1;
    for(let i=0;i<Math.min(arr.length,50);i++){
      if(arr[i]&&typeof arr[i]==='object'&&!Array.isArray(arr[i])){
        const keys=Object.keys(arr[i]);
        if(keys.includes('spec_detail')||keys.includes('spec')){
          productIdx=i;
          break;
        }
      }
    }
    if(productIdx<0)return null;
    const product=arr[productIdx];

    // Extract product name — look for the "name" field
    let name='';
    if(product.name!==undefined)name=resolve(product.name);
    // Also try "title"
    if(!name&&product.title!==undefined)name=resolve(product.title);

    // Extract SKU
    let sku='';
    if(product.sku!==undefined)sku=resolve(product.sku);

    // Extract brand
    let brand='';
    if(product.brand!==undefined)brand=resolve(product.brand);

    // Extract spec summary
    let specSummary='';
    if(product.spec!==undefined)specSummary=resolve(product.spec);

    return{name,sku,brand,specSummary};
  }catch(e){
    return null;
  }
}

const brandKeywords=[
  "MSI","ASUS","Acer","Lenovo","HP","Dell","Apple","MacBook","Huawei","Samsung",
  "LG","Razer","Gigabyte","GPD","Mechrevo","InBook","Alienware","ROG","TUF",
  "VivoBook","ZenBook","Omen","Victus","ThinkPad","IdeaPad","Legion","Yoga",
  "Surface","Latitude","XPS","Inspiron","Pavilion","EliteBook","ProBook",
  "MacBook Air","MacBook Pro","Mac Mini","Mac Studio","Pegasus"
];

function extractBrand(name){
  if(!name)return"";
  for(const bk of brandKeywords){
    if(name.includes(bk))return bk;
  }
  const words=name.split(/\s+/);
  for(const w of words){
    for(const bk of brandKeywords){
      if(bk.toLowerCase().startsWith(w.toLowerCase())||w.toLowerCase().startsWith(bk.toLowerCase())){
        return bk;
      }
    }
    if(brandKeywords.some(bk=>bk.toLowerCase().includes(w.toLowerCase())||w.toLowerCase().includes(bk.toLowerCase()))){
      for(const bk of brandKeywords){
        if(bk.toLowerCase().includes(w.toLowerCase()))return bk;
      }
    }
  }
  return"";
}

function extractProductCode(url){
  if(!url)return"";
  // Extract model code from URL slug
  // e.g., /product/notebook/notebook-dell/notebook-dell-plus-odb16250u701-titan-grey- → ODB16250U701
  // Try to find a model-like code: letters+digits pattern (e.g., ODB16250U701, 15IAH7H, GF63 Thin 11SC)
  const slugMatch=url.match(/\/product\/[^/]+\/(.+)/);
  if(slugMatch){
    const slug=slugMatch[1];
    // Find model codes: patterns like odb16250u701, 15iah7h, gf63thin11sc, etc.
    const modelPatterns=[
      /([a-z]{2,}[a-z0-9]{3,})/i,  // e.g., odb16250u701, vivobook15
      /(\d{2}[a-z]+[a-z0-9]*)/i,   // e.g., 15iah7h
    ];
    for(const mp of modelPatterns){
      const matches=[...slug.matchAll(new RegExp(mp,'gi'))];
      // Pick the most model-like match (has both letters and digits, length >= 5)
      for(const m of matches){
        const code=m[1];
        if(code.length>=5&&/[a-z]/i.test(code)&&/\d/.test(code)){
          return code.toUpperCase();
        }
      }
    }
  }
  // Fallback: original patterns
  const patterns=[
    /\/product\/(?:notebook|laptop)[^-]*-([A-Za-z0-9][A-Za-z0-9_+-]+)(?:-\d+TH)?/i,
    /-([A-Za-z0-9][A-Za-z0-9_+-]+)(?:-\d+TH)?$/i,
  ];
  for(const p of patterns){
    const m=url.match(p);
    if(m&&m[1]){
      let code=m[1];
      code=code.replace(/-\d+$/,"");
      return code;
    }
  }
  return"";
}

function extractSpecifications(element){
  const textContent=element.textContent||"";
  const lines=textContent.split(/[\n\r]+/).map(t=>t.trim()).filter(t=>t.length>0&&t.length<600);
  
  // Keywords that indicate a spec line
  const specKeywords=["inch","Intel","AMD","SSD","RAM","GB","Core","Ryzen","i3","i5","i7","i9","RTX","GTX","Win 11","Windows","display","OLED","IPS","Touch","Hz","MHz","TB","KB","USB","Thunderbolt","Bluetooth","Wi-Fi","card","Graphics","Integrated","MUX","Nano"];
  
  function isSpecLine(line){
    return specKeywords.some(kw=>line.includes(kw));
  }
  
  const specLines=lines.filter(isSpecLine);
  
  // Sort by length descending, prefer longer/more complete specs
  specLines.sort((a,b)=>b.length-a.length);
  
  // Also check for spec lines in non-classed divs
  const nonClassedDivs=element.querySelectorAll("div:not([class])");
  for(const div of nonClassedDivs){
    const txt=div.textContent.trim();
    if(txt.length>20&&isSpecLine(txt)){
      if(txt.length>specLines[0]?.length){
        specLines.unshift(txt);
      }
    }
  }
  
  if(specLines.length>0){
    return stripThai(cleanHtmlEntities(specLines[0]));
  }
  return"";
}

function extractFreeGifts(textContent){
  const gifts=[];
  // Match "Free Gift:" or "แถมฟรี:" followed by comma-separated items
  const giftMatch=textContent.match(/(?:Free Gift|แถมฟรี)[:\s]*([\s\S]*?)(?=฿|[\d,]+\s*(?:บาท|Baht)|Warranty|Shipping|Online|View more|View More|$)/i);
  if(giftMatch){
    const items=giftMatch[1].split(/,|,/).map(s=>stripThai(s.trim())).filter(s=>s.length>0);
    gifts.push(...items);
  }
  return gifts;
}

const PRODUCT_LINK_SEL='a[href*="/product/notebook"], a[href*="/product/laptop"], a[href*="/product/it"]';

function countProductLinks(root){
  if(!root)return 0;
  return root.querySelectorAll(PRODUCT_LINK_SEL).length;
}

function findProductCard(link){
  if(!link)return null;
  // Most specific: an ancestor whose class contains BOTH "product" AND ("item"|"card").
  // This skips grid/list containers which only have "list"/"grid" in their class.
  let el=link;
  for(let depth=0;depth<12&&el&&el.parentElement;depth++){
    el=el.parentElement;
    if(!el||!el.className)continue;
    const cls=el.className.toString().toLowerCase();
    const hasProduct=cls.includes('product');
    const hasCardish=cls.includes('card')||cls.includes('item')||cls.includes('wrapper')||cls.includes('tile')||cls.includes('box');
    if(hasProduct&&hasCardish){
      // Make sure this ancestor contains exactly ONE product link — otherwise it's the grid.
      const linksInside=countProductLinks(el);
      if(linksInside===1)return el;
    }
  }
  // Second pass: walk up and pick the deepest ancestor that still contains exactly
  // one product link (this catches cards with no "product" in the class name).
  el=link;
  let candidate=null;
  for(let depth=0;depth<12&&el&&el.parentElement;depth++){
    el=el.parentElement;
    if(!el)break;
    const linksInside=countProductLinks(el);
    if(linksInside===1){
      candidate=el;
    }else if(linksInside>1){
      // We've stepped into the grid/list wrapper — stop and use the previous candidate.
      break;
    }
  }
  if(candidate)return candidate;
  // Last resort: use the link's own parent.
  return link.parentElement||link;
}

function getProductLinkCount(){
  return document.querySelectorAll(PRODUCT_LINK_SEL).length;
}

async function loadAllProducts(maxRounds=20,delayMs=1500){
  let prev=-1;
  for(let i=0;i<maxRounds;i++){
    const cur=getProductLinkCount();
    if(cur===prev&&cur>0)break;
    prev=cur;
    window.scrollTo(0,document.body.scrollHeight);
    await new Promise(r=>setTimeout(r,delayMs));
  }
  // Scroll back to top so the user sees the scraped cards.
  window.scrollTo(0,0);
  await new Promise(r=>setTimeout(r,300));
}

function I(){
  const e=window.location.href;
  const r=new Date().toISOString();
  try{
    let c=0;

    // Total count: search likely header nodes for "(N List)" / "(N รายการ)".
    const headerSources=[];
    document.querySelectorAll('.text-h2,.results-count,[class*="results"],[class*="result"],[class*="total"],[class*="count"],[class*="matching"],[class*="Matching"],[class*="search-result"],[class*="SearchResult"],h1,h2,h3,[class*="title"],[class*="header"]').forEach(n=>headerSources.push(n));
    if(headerSources.length===0)headerSources.push(document.body);
    for(const node of headerSources){
      const t=(node.textContent||"").slice(0,2000);
      const m=t.match(/\((\d{1,4})\s*(?:รายการ|List|items?)\)/i)
            ||t.match(/(\d{1,4})\s*(?:รายการ|List|items?)/i);
      if(m){c=parseInt(m[1],10);break;}
    }

    // Primary path: containment-based card detection per link.
    const productLinks=document.querySelectorAll(PRODUCT_LINK_SEL);
    const seenCard=new Set();
    let a=[];
    productLinks.forEach(o=>{
      if(!o.href)return;
      const card=findProductCard(o);
      if(!card)return;
      // De-dupe by the actual card element so multiple links in one card don't multiply it.
      if(seenCard.has(card))return;
      seenCard.add(card);

      const h=k(card,o.href);
      if(h)a.push(h);
    });

    // Final URL-level dedupe as a safety net.
    const urlSet=new Set();
    a=a.filter(p=>{
      if(!p.url)return false;
      if(urlSet.has(p.url))return false;
      urlSet.add(p.url);
      return true;
    });

    if(c===0&&a.length>0)c=a.length;

    return{url:e,timestamp:r,totalResults:c,products:a,success:true};
  }catch(err){
    return{url:e,timestamp:r,totalResults:0,products:[],success:false,error:err instanceof Error?err.message:"Unknown error occurred"};
  }
}

function safeText(el){
  try{return (el?.textContent||"").trim();}catch{return"";}
}
function safeGet(el,attr){
  try{return el?.getAttribute?el.getAttribute(attr)||"":"";}catch{return"";}
}

function k(element,r){
  // Always return an object — never null. If extraction fails for a field,
  // leave it empty so dedup-by-URL still keeps this card.
  const out={
    brand:"",
    name:"",
    productCode:"",
    url:"",
    imageUrl:"",
    specifications:"",
    price:"",
    priceValue:null,
    originalPrice:"",
    originalPriceValue:null,
    warranty:"",
    shipping:"",
    isOnlineOnly:false,
    stock:"",
    freeGifts:[],
    promotions:[]
  };
  try{
    const productLink=element.querySelector('a[href*="/product/"]');
    out.url=r||productLink?.href||"";
    out.productCode=extractProductCode(out.url);

    // Name: prefer the link's text, then img alt, then any heading-ish element.
    out.name=safeText(productLink);
    if(!out.name){
      // Try the img inside the product link — its alt text often has the full product name.
      const imgAlt=productLink.querySelector('img')?.getAttribute('alt');
      if(imgAlt&&imgAlt.trim().length>=15)out.name=imgAlt.trim();
    }
    if(!out.name){
      const allLinks=element.querySelectorAll('a');
      for(const lnk of allLinks){
        const txt=safeText(lnk);
        if(txt.length>=15&&txt.length<=300){out.name=txt;break;}
      }
    }
    if(!out.name){
      // Try h1-h4 inside the card, or any element with title/name class.
      const h=element.querySelector('h1,h2,h3,h4,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]');
      if(h)out.name=safeText(h);
    }
    // Last resort: take the first 15-300 char line of text content.
    if(!out.name){
      const lines=(element.textContent||"").split(/[\n\r]+/).map(t=>t.trim()).filter(t=>t.length>=15&&t.length<=300);
      if(lines.length>0)out.name=lines[0];
    }

    // Clean name: strip Thai marketing text (e.g., "... Titan Grey: ประสิทธิภาพสูง ราคาดี พร้อมโปรโมชั่นพิเศษ!")
    if(out.name){
      // Remove Thai suffixes after colon if the rest is Thai
      out.name=out.name.replace(/[:：]\s*[\u0E00-\u0E7F].*$/,'').trim();
      // If name is still mostly Thai, try to get English part
      if(hasThai(out.name)&&!isMostlyEnglish(out.name)){
        const enPart=out.name.replace(/[\u0E00-\u0E7F]+/g,' ').replace(/\s+/g,' ').trim();
        if(enPart.length>=10)out.name=enPart;
      }
      // Final fallback: strip any remaining Thai
      out.name=stripThai(out.name);
    }

    // Brand — try class-based element first, then name, then scan card text for brand keyword at start of line.
    const brandEl=element.querySelector('[class*="brand"], .brand, [class*="Brand"], [class*="manufacturer"], [class*="Manufacturer"]');
    if(brandEl)out.brand=safeText(brandEl);
    if(!out.brand&&out.name)out.brand=extractBrand(out.name);
    // Fallback: scan the card text for a brand keyword appearing near the beginning (before or above the name).
    if(!out.brand){
      const text=element.textContent||"";
      for(const bk of brandKeywords){
        // Brand appears near the start of the text, before the product name.
        const idx=text.indexOf(bk);
        if(idx>=0&&idx<100){
          out.brand=bk;
          break;
        }
      }
    }

    // Image URL.
    const img=element.querySelector("img");
    if(img){
      out.imageUrl=img.src||img.dataset?.src||safeGet(img,"data-src")||safeGet(img,"data-lazy")||safeGet(img,"data-original")||"";
    }

// Specifications.
    out.specifications=extractSpecifications(element);

    // Price — extract using the robust extractPrice (handles HTML-encoded ฿).
    const textContent=element.textContent||"";
    const ep=extractPrice(textContent);
    if(ep){
      out.price=ep.str;
      out.priceValue=ep.val;
    }
    // Also capture originalPrice (the first struck-through price, if multiple).
    // Normalize HTML entities so we can match ฿ reliably.
    const normalizedText=textContent
    .replace(/&#(\d+);?/g,(_,d)=>{
      const cp=parseInt(d,10);
      return cp===3647||cp===3647?'฿':String.fromCharCode(cp);
    })
    .replace(/&#x0*E3F;?/gi,'฿');
    const allPriceMatches=normalizedText.match(/฿[\d,]+/g)||[];
    const cleanForOriginal=[];
    for(const tok of allPriceMatches){
      const idx=normalizedText.indexOf(tok);
      const before=normalizedText.slice(Math.max(0,idx-2),idx);
      if(before.includes("-")||before.includes("−"))continue;
      cleanForOriginal.push(tok);
    }
    if(cleanForOriginal.length>=2){
      out.originalPrice=cleanForOriginal[0];
      out.originalPriceValue=U(cleanForOriginal[0]);
    }

    // Warranty — English only.
    const warrantyMatch=textContent.match(/Warranty[:\s]*([^\n฿]{3,40})/i);
    if(warrantyMatch){
      out.warranty='Warranty: '+warrantyMatch[1].trim().replace(/Shipping.*/i,'').trim();
    }

    // Shipping — English only.
    const shippingMatch=textContent.match(/(?:Free Shipping|(?:Shipping|จัดส่ง)[:\s]*[^\n฿]{3,40})/i);
    if(shippingMatch){
      let s=shippingMatch[0].trim();
      if(s.includes('Free Shipping'))s='Free Shipping';
      else s='Shipping: '+s.replace(/^(?:Shipping|จัดส่ง)\s*/i,'').trim();
      // Strip trailing Thai
      s=stripThai(s).replace(/Shipping:\s*$/,'').trim();
      if(s)out.shipping=s;
    }

    // Online only.
    out.isOnlineOnly=textContent.includes("ราคานี้เฉพาะออนไลน์เท่านั้น")||textContent.includes("*Online Only Price")||textContent.includes("Online Only");

    // Stock — "Product View2.7 K" pattern.
    const stockMatch=textContent.match(/Product\s*View\s*([\d.]+)\s*([Kk])?/i);
    if(stockMatch)out.stock=stockMatch[1]+(stockMatch[2]||"");

    // Free gifts.
    out.freeGifts=extractFreeGifts(textContent);

    // Promotions.
    if(element.querySelector('img[src*="promotion"], [class*="promo"], [class*="Promo"], [class*="COPILOT"]')){
      out.promotions.push("Promotion");
    }

    return out;
  }catch(err){
    // Still return what we managed to collect.
    if(!out.url&&r)out.url=r;
    return out;
  }
}

function safeTextOf(el){
  if(!el)return"";
  return (el.textContent||"").replace(/\s+/g," ").trim();
}

function extractDetailImages(){
  // Collect every product image on the page: main gallery + thumbnails + zoom.
  const imgs=[];
  const seen=new Set();
  // Common advice.co.th selectors for the main product image.
  const sels=[
    '[class*="product-image"] img',
    '[class*="product-gallery"] img',
    '[class*="gallery"] img',
    '[class*="slider"] img',
    '[class*="swiper"] img',
    '[class*="ProductImage"] img',
    '[class*="zoom"] img',
    '.main-image img',
    '#product-image img',
    'img[itemprop="image"]',
    'img[alt][src*="advice"]',
  ];
  document.querySelectorAll(sels.join(",")).forEach(img=>{
    let src=img.src||img.dataset?.src||img.getAttribute("data-src")||img.getAttribute("data-original")||img.getAttribute("data-zoom-image")||img.getAttribute("data-large")||"";
    if(!src)return;
    // Strip query params for dedup, keep high-res if present.
    src=src.split("?")[0];
    if(!src.startsWith("http"))return;
    if(seen.has(src))return;
    seen.add(src);
    imgs.push(src);
  });
  return imgs;
}

function extractDescriptionBullets(){
  const out=[];
  const candidates=document.querySelectorAll('[class*="description"] li, [class*="Description"] li, [class*="feature"] li, [class*="Feature"] li, [class*="highlight"] li, [class*="Highlight"] li');
  candidates.forEach(li=>{
    let t=safeTextOf(li);
    if(t.length<5||t.length>500||out.includes(t))return;
    // Skip Thai-only descriptions
    if(hasThai(t)&&!isMostlyEnglish(t))return;
    // Strip Thai and clean HTML entities
    t=cleanHtmlEntities(t);
    t=stripThai(t);
    if(t.length>=5)out.push(t);
  });
  return out;
}

function extractSpecificationsTable(){
  // PRIMARY: Try parsing from __NUXT_DATA__ (advice.co.th stores specs in JSON, not DOM)
  const nuxtSpecs=parseNuxtSpecs(document);
  if(nuxtSpecs.length>0)return nuxtSpecs;

  // FALLBACK: DOM-based extraction (for non-Nuxt pages or if NUXT parsing fails)
  const rows=[];
  const seenKeys=new Set();

  function addRow(key,value){
    key=cleanHtmlEntities(key);
    value=cleanHtmlEntities(value);
    if(!key||!value||key===value||key.length>120||value.length>2000)return;
    if(isGarbageSpecKey(key))return;
    if(isGarbageSpecValue(value))return;
    const normKey=key.toLowerCase().trim();
    if(seenKeys.has(normKey))return;
    seenKeys.add(normKey);
    const cleanKey=stripThai(key);
    const cleanValue=stripThai(value);
    if(!cleanKey||!cleanValue)return;
    rows.push({key:cleanKey,value:cleanValue});
  }

  // 1. Table-based (th/td)
  document.querySelectorAll('table tr').forEach(tr=>{
    const cells=tr.querySelectorAll('th, td');
    if(cells.length>=2){
      addRow(safeTextOf(cells[0]),safeTextOf(cells[cells.length-1]));
    }
  });

  // 2. Definition lists (dl/dt/dd)
  document.querySelectorAll('dl').forEach(dl=>{
    const dts=dl.querySelectorAll('dt');
    const dds=dl.querySelectorAll('dd');
    dts.forEach((dt,i)=>{
      addRow(safeTextOf(dt),safeTextOf(dds[i]||''));
    });
  });

  // 3. Fallback: spec labels via text search
  if(rows.length<5){
    const specLabels=[
      'Processor','Chipset','AI Engine','Graphics','Display Screen','Main Memory','Memory Slot','Max Memory',
      'Storage','Storage Slot','Web Camera','Sound Technology','Audio Jack','Speaker','OS',
      'Wireless','Bluetooth','Ports','Power Adapter','Battery',
      'Dimension','Net Weight','Package Dimension','Gross Weight','Volume','Material',
      'Keyboard Type','Backlit','Touchpad','Finger Print','Warranty','Brand','Model'
    ];
    specLabels.forEach(label=>{
      if(seenKeys.has(label.toLowerCase()))return;
      const escapedLabel=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const regex=new RegExp(escapedLabel+'\\s*[:]?\\s*([^\\n\\r]{5,200})','i');
      const match=(document.body.textContent||'').match(regex);
      if(match){
        addRow(label,match[1].trim());
      }
    });
  }

  return rows;
}

function extractFreeGiftsDetail(){
  // Each free gift: name + quantity (X1, X2) + individual price.
  const gifts=[];
  // Pattern: a card with title, "X<num>", and a price.
  document.querySelectorAll('[class*="free-gift"] [class*="item"], [class*="FreeGift"] [class*="item"], [class*="bundle"] [class*="item"], [class*="Bundle"] [class*="item"]').forEach(item=>{
    const name=safeTextOf(item.querySelector('[class*="name"], [class*="title"], [class*="Title"], h1, h2, h3, h4, h5, strong, b'));
    const qtyMatch=safeTextOf(item).match(/X\s*(\d+)/i);
    const priceMatch=safeTextOf(item).match(/฿[\d,]+/);
    if(name){
      gifts.push({
        name,
        quantity:qtyMatch?parseInt(qtyMatch[1],10):1,
        price:priceMatch?priceMatch[0]:""
      });
    }
  });
  // Fallback: parse the "Free Item N Items list" pattern from full text.
  if(gifts.length===0){
    const text=document.body.textContent||"";
    const m=text.match(/Free Item\s*\d+\s*Items?\s*list[^]*?(?=Warranty|Shipping|Quantity|Add Cart|$)/i);
    if(m){
      // Split on lines that contain ฿ or X<num>.
      const block=m[0];
      block.split(/\n|(?=฿)|(?=X\s*\d+)/).forEach(seg=>{
        const name=seg.replace(/฿[\d,]+/,"").replace(/X\s*\d+/i,"").trim();
        const price=(seg.match(/฿[\d,]+/)||[""])[0];
        const qty=(seg.match(/X\s*(\d+)/i)||[])[1];
        if(name.length>3&&name.length<200)gifts.push({name,quantity:qty?parseInt(qty,10):1,price});
      });
    }
  }
  return gifts;
}

function extractSku(){
  const m=(document.body.textContent||"").match(/SKU\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,20})/i);
  return m?m[1].trim():"";
}

function k_detail(url){
  const out={
    success:true,
    url:url||window.location.href,
    sku:"",
    brand:"",
    name:"",
    productCode:"",
    price:"",
    priceValue:null,
    originalPrice:"",
    originalPriceValue:null,
    discount:"",
    isOnlineOnly:false,
    warranty:"",
    shipping:"",
    description:[],
    images:[],
    freeGiftsDetail:[],
    specifications:[],
    installment:"",
    quantity:"1"
  };
  try{
    out.url=url||window.location.href;
    out.productCode=extractProductCode(out.url);

    // Try NUXT data for clean name/brand first
    const nuxtInfo=parseNuxtProductInfo(document);
    if(nuxtInfo&&nuxtInfo.name){
      out.name=stripThai(nuxtInfo.name.replace(/[:：]\s*[\u0E00-\u0E7F].*$/,'').trim());
    }

    // Name: usually in <h1>, or meta og:title.
    if(!out.name){
      const h1=document.querySelector('h1');
      if(h1)out.name=safeTextOf(h1);
    }
    if(!out.name){
      const og=document.querySelector('meta[property="og:title"]');
      if(og)out.name=(og.getAttribute("content")||"").trim();
    }
    if(!out.name)out.name=document.title||"";
    // Clean name: strip Thai marketing text
    if(out.name){
      out.name=out.name.replace(/[:：]\s*[\u0E00-\u0E7F].*$/,'').trim();
      if(hasThai(out.name)&&!isMostlyEnglish(out.name)){
        const enPart=out.name.replace(/[\u0E00-\u0E7F]+/g,' ').replace(/\s+/g,' ').trim();
        if(enPart.length>=10)out.name=enPart;
      }
      out.name=stripThai(out.name);
    }

    // Brand: try NUXT data, then class, then extract from name.
    if(nuxtInfo&&nuxtInfo.brand){
      out.brand=stripThai(nuxtInfo.brand);
    }
    if(!out.brand){
      const brandEl=document.querySelector('[class*="brand"], .brand, [class*="Brand"], [class*="manufacturer"], [class*="Manufacturer"]');
      if(brandEl)out.brand=safeTextOf(brandEl);
    }
    if(!out.brand&&out.name)out.brand=extractBrand(out.name);

    // SKU.
    out.sku=extractSku();

    // Prices — read carefully: usually two labels, "Online Price Only" and "Retail Price".
    // Read each <span>/<div> whose text contains "Price" and grab the next ฿ number.
    const priceLabels=Array.from(document.querySelectorAll('*')).filter(el=>{
      const t=safeTextOf(el);
      return /Online Price Only|ราคานี้เฉพาะออนไลน์|Retail Price|ราคาปกติ/i.test(t)&&t.length<80;
    });
    const seen=new Set();
    priceLabels.forEach(label=>{
      const t=safeTextOf(label);
      const ep=extractPrice(t);
      if(!ep)return;
      if(/Retail|ราคาปกติ/i.test(t)&&!seen.has("retail")){
        out.originalPrice=ep.str;
        out.originalPriceValue=ep.val;
        seen.add("retail");
      }else if(/Online|ออนไลน์/i.test(t)&&!seen.has("online")){
        out.price=ep.str;
        out.priceValue=ep.val;
        seen.add("online");
      }
    });
    // Fallback to whole-page scan if structured extraction missed.
    if(!out.priceValue){
      const ep=extractPrice(document.body.textContent||"");
      if(ep){
        out.price=ep.str;
        out.priceValue=ep.val;
      }
      // Also get original price if there are at least 2 clean prices.
      const allMatches=(document.body.textContent||"").match(/฿[\d,]+/g)||[];
      const clean=[];
      for(const tok of allMatches){
        const idx=(document.body.textContent||"").indexOf(tok);
        const before=(document.body.textContent||"").slice(Math.max(0,idx-3),idx);
        if(before.includes("-")||before.includes("−"))continue;
        clean.push(tok);
      }
      if(clean.length>=2){
        out.originalPrice=clean[0];
        out.originalPriceValue=U(clean[0]);
      }
    }

    // Discount — also handle HTML-encoded baht.
    const discountText=document.body.textContent||"";
    const discountMatch=discountText.match(/ประหยัด\s*&#?\w+;?\s*([\d,]+)|ประหยัด\s*฿\s*([\d,]+)/i);
    if(discountMatch){
      out.discount=(discountMatch[0].match(/฿\s*[\d,]+|&#?\w+;\s*[\d,]+/i)||[discountMatch[0]])[0];
    }

    // Warranty — English only.
    const warrantyMatch=(document.body.textContent||"").match(/Warranty[:\s]*([^\n฿]{3,40})/i);
    if(warrantyMatch)out.warranty='Warranty: '+warrantyMatch[1].trim().replace(/Shipping.*/i,'').trim();

    // Shipping — English only.
    if((document.body.textContent||"").includes("Free Shipping")){
      out.shipping="Free Shipping";
    }

    // Online only.
    out.isOnlineOnly=(document.body.textContent||"").includes("Online Price Only")||(document.body.textContent||"").includes("ราคานี้เฉพาะออนไลน์");

    // Images.
    out.images=extractDetailImages();

    // Description.
    out.description=extractDescriptionBullets();

    // Specifications table.
    out.specifications=extractSpecificationsTable();

    // Free gifts detail.
    out.freeGiftsDetail=extractFreeGiftsDetail();

    // Installment — handle HTML-encoded baht.
    const installmentText=document.body.textContent||"";
    const installmentMatch=installmentText.match(/Starting\s*&#?\w+;?\s*[\d,]+\s*\/\s*Month|Starting\s*฿[\d,]+\s*\/\s*Month|เริ่มต้น\s*&#?\w+;?\s*[\d,]+\s*\/\s*เดือน|เริ่มต้น\s*฿[\d,]+\s*\/\s*เดือน/i);
    if(installmentMatch)out.installment=installmentMatch[0];

    return out;
  }catch(err){
    out.success=false;
    out.error=err instanceof Error?err.message:String(err);
    return out;
  }
}

// Inject a small floating report card on the page after scraping completes.
let _scrapeReportEl=null;
let _scrapeReportTimer=null;
function showScrapeReport(result){
  // Remove any previous report.
  if(_scrapeReportEl){_scrapeReportEl.remove();_scrapeReportEl=null;}
  if(_scrapeReportTimer){clearTimeout(_scrapeReportTimer);_scrapeReportTimer=null;}
  if(!result?.products?.length)return;
  const products=result.products;
  const prices=products.map(p=>p.priceValue).filter(v=>v!=null);
  const brands=[...new Set(products.map(p=>p.brand).filter(Boolean))];
  const min=prices.length?Math.min(...prices):0;
  const max=prices.length?Math.max(...prices):0;
  const avg=prices.length?Math.round(prices.reduce((a,b)=>a+b,0)/prices.length):0;
  _scrapeReportEl=document.createElement('div');
  _scrapeReportEl.id='advice-scraper-report';
  _scrapeReportEl._products=products;
  _scrapeReportEl._prices=prices;
  _scrapeReportEl._brands=brands;
  _scrapeReportEl._min=min;
  _scrapeReportEl._max=max;
  _scrapeReportEl._avg=avg;
  _scrapeReportEl.style='position:fixed;bottom:20px;right:20px;z-index:99999;background:#1a1a2e;color:#fff;';
  _scrapeReportEl.style+='padding:16px 20px;border-radius:12px;font-family:system-ui,sans-serif;font-size:13px;';
  _scrapeReportEl.style+='box-shadow:0 4px 20px rgba(0,0,0,0.4);min-width:220px;line-height:1.6;';
  _scrapeReportEl.style+='border:1px solid rgba(255,255,255,0.1);';
  _scrapeReportEl.innerHTML=_buildReportHTML(products.length,prices,brands,min,max,avg,0,products.length);
  document.body.appendChild(_scrapeReportEl);
}

function _buildReportHTML(count,prices,brands,min,max,avg,enrichDone,enrichTotal){
  const enrichSection=enrichTotal>0
    ?`<div style="color:#e94560;margin-top:10px;font-size:12px;">
       Fetching details: ${enrichDone}/${enrichTotal}
       <div style="width:120px;height:4px;background:#333;border-radius:2px;margin-top:4px;">
         <div style="width:${Math.round(enrichDone/enrichTotal*100)}%;height:100%;background:#e94560;border-radius:2px;"></div>
       </div>
     </div>`
    :`<div style="color:#555;font-size:11px;margin-top:10px;">
       Detail enrichment running in background...
     </div>`;
  return`
    <div style="font-weight:700;font-size:15px;margin-bottom:10px;color:#e94560;">
      Advice.co.th Scraper
    </div>
    <div style="color:#aaa;margin-bottom:8px;">
      Scraped: ${count} products
    </div>
    ${prices.length?`<div style="color:#aaa;">Avg: <span style="color:#fff;">฿${avg.toLocaleString()}</span></div>
    <div style="color:#aaa;">Range: <span style="color:#fff;">฿${min.toLocaleString()} – ฿${max.toLocaleString()}</span></div>`:''}
    ${brands.length?`<div style="color:#aaa;margin-top:8px;">Brands: <span style="color:#fff;">${brands.slice(0,5).join(', ')}${brands.length>5?', +'+(brands.length-5):''}</span></div>`:''}
    ${enrichSection}
    <div style="color:#555;font-size:11px;margin-top:8px;">
      ${enrichDone>0&&enrichDone===enrichTotal?'✅ All details fetched!':'⏳ Open popup to export.'}
    </div>
  `;
}

function updateScrapeReportProgress(done,total){
  if(!_scrapeReportEl)return;
  const products=_scrapeReportEl._products||[];
  const prices=_scrapeReportEl._prices||[];
  const brands=_scrapeReportEl._brands||[];
  const min=_scrapeReportEl._min||0;
  const max=_scrapeReportEl._max||0;
  const avg=_scrapeReportEl._avg||0;
  _scrapeReportEl.innerHTML=_buildReportHTML(products.length,prices,brands,min,max,avg,done,total);
  if(done>0&&done===total&&_scrapeReportTimer){clearTimeout(_scrapeReportTimer);}
}

function setScrapeReportFinal(){
  if(!_scrapeReportEl)return;
  if(_scrapeReportTimer){clearTimeout(_scrapeReportTimer);}
  _scrapeReportTimer=setTimeout(()=>{const r=document.getElementById('advice-scraper-report');if(r)r.remove();},30000);
}

chrome.runtime.onMessage.addListener((msg,_,callback)=>{
  if(msg.action==="scrape"){
    loadAllProducts()
      .then(()=>{
        const result=I();
        showScrapeReport(result);
        try{
          startEnrichmentAfterScrape(result);
        }catch(err){
          console.error("[scraper] enrichment error:",err);
        }
        callback(result);
      })
      .catch(err=>callback({success:false,error:err.message||String(err)}));
    return true;
  }
  if(msg.action==="scrapeDetail"){
    try{
      const result=k_detail(msg.url);
      callback(result);
    }catch(err){
      callback({success:false,error:err.message||String(err)});
    }
    return true;
  }
  if(msg.action==="getPageInfo"){
    callback({
      url:window.location.href,
      title:document.title,
      isAdviceSite:window.location.hostname.includes("advice.co.th"),
      hasProducts:document.querySelectorAll(PRODUCT_LINK_SEL).length>0
    });
    return true;
  }
  if(msg.action==="scrollToLoad"){
    loadAllProducts().then(()=>callback({scrolled:true})).catch(()=>callback({scrolled:false}));
    return true;
  }
  if(msg.action==="enrichProgress"){
    // Update the floating report with enrichment progress.
    const p=msg.progress;
    if(p&&_scrapeReportEl){
      updateScrapeReportProgress(p.done,p.total);
    }
    return false;
  }
  if(msg.action==="enrichComplete"){
    // Enrichment finished — update report and re-store results.
    if(_scrapeReportEl){
      updateScrapeReportProgress(
        msg.products?.length||0,
        msg.products?.length||0
      );
      setScrapeReportFinal();
    }
    if(msg.products?.length){
      chrome.storage.local.set({lastScraped:{
        url:window.location.href,
        timestamp:new Date().toISOString(),
        totalResults:msg.products.length,
        products:msg.products,
        success:true
      }});
    }
    return false;
  }
  return false;
});

// ─── Parallel iframe-based detail enrichment ───────────────────────────────
// Uses hidden iframes (same-origin) to fetch detail pages in parallel.
// This runs inside the advice.co.th page context, so it inherits the user's
// session and bypasses CORS / Cloudflare challenges that XHR would face.
const _enr = {
  queue: [],       // URLs remaining
  results: [],      // enriched products so far
  total: 0,
  done: 0,
  concurrency: 6,  // parallel iframes (balanced against Cloudflare)
  running: 0,
  onProgress: null, // callback(done, total, currentProduct)
  abort: false
};

function _enrichTick() {
  if (_enr.abort) { console.log('[enrich] aborted'); return; }
  while (_enr.running < _enr.concurrency && _enr.queue.length > 0) {
    const product = _enr.queue.shift();
    _enr.running++;
    console.log('[enrich] opening iframe for', product.url);
    _openDetailIframe(product);
  }
  if (_enr.running === 0 && _enr.queue.length === 0) {
    console.log('[enrich] all done, notifying background');
    _enr.onProgress && _enr.onProgress(_enr.total, _enr.total, null);
    _notifyBackgroundEnrichDone(_enr.results);
  }
}

function _openDetailIframe(product) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'display:none;width:0;height:0;border:none;position:absolute;';
  iframe.src = product.url;
  document.body.appendChild(iframe);
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    iframe.remove();
    _enr.running--;
    _enr.results.push({ ...product, detailFetched: false, detailError: 'timeout' });
    _enr.done++;
    _enr.onProgress && _enr.onProgress(_enr.done, _enr.total, product.url);
    _enrichTick();
  }, 20000); // 20s per iframe

  iframe.onload = iframe.onerror = () => {
    if (settled) return;
    clearTimeout(timer);
    settled = true;
    const win = iframe.contentWindow;
    console.log('[enrich] iframe loaded for', product.url, 'childNodes:', win && win.document && win.document.body && win.document.body.childNodes.length);
    try {
      if (win && win.document && win.document.body && win.document.body.childNodes.length > 5) {
        // Only parse if the page actually loaded content (body has real children).
        const detail = _kDetailFromWindow(win, product.url);
        if (detail.success !== false) {
          _enr.results.push({ ...product, ...detail, detailFetched: true });
        } else {
          _enr.results.push({ ...product, detailFetched: false, detailError: detail.error || 'parse failed' });
        }
      } else {
        _enr.results.push({ ...product, detailFetched: false, detailError: 'empty/Challenge page' });
      }
    } catch (e) {
      _enr.results.push({ ...product, detailFetched: false, detailError: String(e) });
    }
    iframe.remove();
    _enr.running--;
    _enr.done++;
    _enr.onProgress && _enr.onProgress(_enr.done, _enr.total, product.url);
    _enrichTick();
  };
}

function _kDetailFromWindow(win, fallbackUrl) {
  try {
    const doc = win.document;
    const out = {
      success: true,
      url: fallbackUrl || win.location.href,
      sku: '', brand: '', name: '', productCode: '',
      price: '', priceValue: null,
      originalPrice: '', originalPriceValue: null,
      discount: '', isOnlineOnly: false, warranty: '', shipping: '',
      description: [], images: [], freeGiftsDetail: [], specifications: [],
      installment: '', quantity: '1'
    };
    out.productCode = _extractProductCode(out.url);

    // Try NUXT data for clean name/brand first
    const nuxtInfo = parseNuxtProductInfo(doc);
    if (nuxtInfo && nuxtInfo.name) {
      out.name = stripThai(nuxtInfo.name.replace(/[:：]\s*[\u0E00-\u0E7F].*$/,'').trim());
    }

    // Name from h1 or og:title (fallback)
    if (!out.name) {
      const h1 = doc.querySelector('h1');
      if (h1) out.name = _safeTextOf(h1);
    }
    if (!out.name) {
      const og = doc.querySelector('meta[property="og:title"]');
      if (og) out.name = (og.getAttribute('content') || '').trim();
    }
    if (!out.name) out.name = doc.title || '';
    // Clean name: strip Thai marketing text
    if(out.name){
      out.name=out.name.replace(/[:：]\s*[\u0E00-\u0E7F].*$/,'').trim();
      if(hasThai(out.name)&&!isMostlyEnglish(out.name)){
        const enPart=out.name.replace(/[\u0E00-\u0E7F]+/g,' ').replace(/\s+/g,' ').trim();
        if(enPart.length>=10)out.name=enPart;
      }
      out.name=stripThai(out.name);
    }

    // Brand: try NUXT data first
    if (nuxtInfo && nuxtInfo.brand) {
      out.brand = stripThai(nuxtInfo.brand);
    }
    if (!out.brand) {
      const brandEl = doc.querySelector('[class*="brand"], .brand, [class*="Brand"]');
      if (brandEl) out.brand = _safeTextOf(brandEl);
    }
    if (!out.brand && out.name) out.brand = _extractBrand(out.name);

    // SKU
    const skuM = (doc.body.textContent || '').match(/SKU\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,20})/i);
    if (skuM) out.sku = skuM[1].trim();

    // Price via structured labels
    const priceLabels = Array.from(doc.querySelectorAll('*')).filter(el => {
      const t = _safeTextOf(el);
      return /Online Price Only|ราคานี้เฉพาะออนไลน์|Retail Price|ราคาปกติ/i.test(t) && t.length < 100;
    });
    const seen = new Set();
    priceLabels.forEach(label => {
      const t = _safeTextOf(label);
      const ep = _extractPrice(t);
      if (!ep) return;
      if (/Retail|ราคาปกติ/i.test(t) && !seen.has('retail')) {
        out.originalPrice = ep.str; out.originalPriceValue = ep.val; seen.add('retail');
      } else if (/Online|ออนไลน์/i.test(t) && !seen.has('online')) {
        out.price = ep.str; out.priceValue = ep.val; seen.add('online');
      }
    });

    // Fallback: whole-page scan
    if (!out.priceValue) {
      const ep = _extractPrice(doc.body.textContent || '');
      if (ep) { out.price = ep.str; out.priceValue = ep.val; }
    }
    if (!out.originalPrice && seen.size >= 2) {
      const allM = (doc.body.textContent || '').match(/฿[\d,]+/g) || [];
      const clean = allM.filter(tok => {
        const idx = (doc.body.textContent || '').indexOf(tok);
        const before = (doc.body.textContent || '').slice(Math.max(0, idx - 3), idx);
        return !before.includes('-') && !before.includes('−');
      });
      if (clean.length >= 2) { out.originalPrice = clean[0]; out.originalPriceValue = _U(clean[0]); }
    }

    // Discount
    const discM = (doc.body.textContent || '').match(/ประหยัด\s*&#?\w+;?\s*([\d,]+)|ประหยัด\s*฿\s*([\d,]+)/i);
    if (discM) out.discount = (discM[0].match(/฿\s*[\d,]+|&#?\w+;\s*[\d,]+/i) || [discM[0]])[0];

    // Warranty — English only
    const wM = (doc.body.textContent || '').match(/Warranty[:\s]*([^\n฿]{3,40})/i);
    if (wM) out.warranty = 'Warranty: ' + wM[1].trim().replace(/Shipping.*/i,'').trim();

    // Shipping — English only
    if ((doc.body.textContent || '').includes('Free Shipping')) {
      out.shipping = 'Free Shipping';
    }

    // Online only
    out.isOnlineOnly = (doc.body.textContent || '').includes('Online Price Only') || (doc.body.textContent || '').includes('ราคานี้เฉพาะออนไลน์');

    // Images — gallery
    const imgs = [];
    const seenImg = new Set();
    doc.querySelectorAll('[class*="product-image"] img,[class*="gallery"] img,[class*="swiper"] img,[class*="slider"] img,img[itemprop="image"],.main-image img,#product-image img')
      .forEach(img => {
        let src = img.src || img.dataset?.src || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-zoom-image') || '';
        if (!src) return;
        src = src.split('?')[0];
        if (!src.startsWith('http') || seenImg.has(src)) return;
        seenImg.add(src);
        imgs.push(src);
      });
    out.images = imgs;

    // Description bullets — English only
    const desc = [];
    doc.querySelectorAll('[class*="description"] li,[class*="Description"] li,[class*="feature"] li,[class*="Feature"] li,[class*="highlight"] li').forEach(li => {
      let t = _safeTextOf(li);
      if (t.length < 5 || t.length > 500 || desc.includes(t)) return;
      // Skip Thai-only descriptions
      if (hasThai(t) && !isMostlyEnglish(t)) return;
      t = cleanHtmlEntities(t);
      t = stripThai(t);
      if (t.length >= 5) desc.push(t);
    });
    out.description = desc;

    // Specs table - enhanced extraction for multiple formats
    function extractSpecsFromDoc(d) {
      // PRIMARY: Try parsing from __NUXT_DATA__
      const nuxtSpecs = parseNuxtSpecs(d);
      if (nuxtSpecs.length > 0) return nuxtSpecs;

      // FALLBACK: DOM-based extraction
      const rows = [];
      const seenKeys = new Set();

      function addRow(key, value) {
        key = cleanHtmlEntities(key);
        value = cleanHtmlEntities(value);
        if (!key || !value || key === value || key.length > 120 || value.length > 2000) return;
        if (isGarbageSpecKey(key)) return;
        if (isGarbageSpecValue(value)) return;
        const normKey = key.toLowerCase().trim();
        if (seenKeys.has(normKey)) return;
        seenKeys.add(normKey);
        const cleanKey = stripThai(key);
        const cleanValue = stripThai(value);
        if (!cleanKey || !cleanValue) return;
        rows.push({ key: cleanKey, value: cleanValue });
      }

      // 1. Table-based (th/td)
      d.querySelectorAll('table tr').forEach(tr => {
        const cells = tr.querySelectorAll('th, td');
        if (cells.length >= 2) {
          addRow(_safeTextOf(cells[0]), _safeTextOf(cells[cells.length - 1]));
        }
      });

      // 2. Definition lists (dl/dt/dd)
      d.querySelectorAll('dl').forEach(dl => {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        dts.forEach((dt, i) => {
          addRow(_safeTextOf(dt), _safeTextOf(dds[i] || ''));
        });
      });

      // 3. Fallback: spec labels via text search
      if (rows.length < 5) {
        const specLabels = [
          'Processor', 'Chipset', 'AI Engine', 'Graphics', 'Display Screen', 'Main Memory', 'Memory Slot', 'Max Memory',
          'Storage', 'Storage Slot', 'Web Camera', 'Sound Technology', 'Audio Jack', 'Speaker', 'OS',
          'Wireless', 'Bluetooth', 'Ports', 'Power Adapter', 'Battery',
          'Dimension', 'Net Weight', 'Package Dimension', 'Gross Weight', 'Volume', 'Material',
          'Keyboard Type', 'Backlit', 'Touchpad', 'Finger Print', 'Warranty', 'Brand', 'Model'
        ];
        specLabels.forEach(label => {
          if (seenKeys.has(label.toLowerCase())) return;
          const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedLabel + '\\s*[:]?\\s*([^\\n\\r]{5,200})', 'i');
          const match = (d.body.textContent || '').match(regex);
          if (match) {
            addRow(label, match[1].trim());
          }
        });
      }

      return rows;
    }

    out.specifications = extractSpecsFromDoc(doc);

    // Free gifts detail
    const gifts = [];
    doc.querySelectorAll('[class*="free-gift"] [class*="item"],[class*="FreeGift"] [class*="item"],[class*="bundle"] [class*="item"]').forEach(item => {
      const name = _safeTextOf(item.querySelector('[class*="name"],[class*="title"],h1,h2,h3,h4,strong,b'));
      const qM = _safeTextOf(item).match(/X\s*(\d+)/i);
      const pM = _safeTextOf(item).match(/฿[\d,]+/);
      if (name) gifts.push({ name, quantity: qM ? parseInt(qM[1]) : 1, price: pM ? pM[0] : '' });
    });
    out.freeGiftsDetail = gifts;

    // Installment
    const instM = (doc.body.textContent || '').match(/Starting\s*&#?\w+;?\s*[\d,]+\s*\/\s*Month|Starting\s*฿[\d,]+\s*\/\s*Month|เริ่มต้น\s*฿[\d,]+\s*\/\s*เดือน/i);
    if (instM) out.installment = instM[0];

    return out;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Expose a minimal API on the window so iframes can be scraped when they finish loading.
window._kDetailFromWindow = _kDetailFromWindow;

function _extractPrice(text) {
  if (!text) return null;
  const normalized = text
    .replace(/&#(\d+);?/g, (_, d) => { const cp = parseInt(d, 10); return cp === 3647 ? '฿' : String.fromCharCode(cp); })
    .replace(/&#x0*E3F;?/gi, '฿')
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const matches = [];
  let re;
  try { re = /฿\s*([\d,]+)/g; } catch (_) { return null; }
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const before = normalized.slice(Math.max(0, m.index - 2), m.index);
    if (before.includes('-') || before.includes('−')) continue;
    matches.push(m[1]);
  }
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { str: '฿' + last, val: _U('฿' + last) };
}

function _U(e) {
  if (!e) return null;
  const norm = e
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[๐๑๒๓๔๕๖๗๘๙]/g, m => '๐๑๒๓๔๕๖๗๘๙'.indexOf(m))
    .replace(/฿/g, '').replace(/,/g, '').trim();
  const r = norm.match(/\d+/);
  return r ? parseInt(r[0], 10) : null;
}

function _extractBrand(name) {
  if (!name) return '';
  for (const bk of brandKeywords) { if (name.includes(bk)) return bk; }
  const words = name.split(/\s+/);
  for (const w of words) {
    for (const bk of brandKeywords) {
      if (bk.toLowerCase().startsWith(w.toLowerCase()) || w.toLowerCase().startsWith(bk.toLowerCase())) return bk;
    }
  }
  return '';
}

function _extractProductCode(url) {
  if (!url) return '';
  // Extract model code from URL slug — same logic as extractProductCode
  const slugMatch = url.match(/\/product\/[^/]+\/(.+)/);
  if (slugMatch) {
    const slug = slugMatch[1];
    const modelPatterns = [
      /([a-z]{2,}[a-z0-9]{3,})/i,
      /(\d{2}[a-z]+[a-z0-9]*)/i,
    ];
    for (const mp of modelPatterns) {
      const matches = [...slug.matchAll(new RegExp(mp, 'gi'))];
      for (const m of matches) {
        const code = m[1];
        if (code.length >= 5 && /[a-z]/i.test(code) && /\d/.test(code)) {
          return code.toUpperCase();
        }
      }
    }
  }
  const patterns = [
    /\/product\/(?:notebook|laptop)[^-]*-([A-Za-z0-9][A-Za-z0-9_+-]+)(?:-\d+TH)?/i,
    /-([A-Za-z0-9][A-Za-z0-9_+-]+)(?:-\d+TH)?$/i,
  ];
  for (const p of patterns) { const m = url.match(p); if (m && m[1]) return m[1].replace(/-\d+$/, '').toUpperCase(); }
  return '';
}

function _safeTextOf(el) {
  if (!el) return '';
  try { return (el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (_) { return ''; }
}

async function _enrichProductsIframe(products, onProgress) {
  _enr.queue = products.filter(p => p && p.url);
  _enr.results = [];
  _enr.total = _enr.queue.length;
  _enr.done = 0;
  _enr.running = 0;
  _enr.abort = false;
  _enr.onProgress = onProgress;
  _enrichTick();
}

// Save partial enriched results to storage after each batch.
let _enrSaveTimer = null;
function _enrScheduleSave() {
  if (_enrSaveTimer) clearTimeout(_enrSaveTimer);
  _enrSaveTimer = setTimeout(async () => {
    if (_enr.results.length > 0) {
      const prev = await chrome.storage.local.get('lastScraped');
      const base = prev.lastScraped || {};
      // Merge enriched results into products array by URL.
      const enrichedMap = new Map(_enr.results.map(r => [r.url, r]));
      const merged = (base.products || []).map(p => enrichedMap.get(p.url) || p);
      // Add any new results not in base
      _enr.results.forEach(r => { if (!merged.find(p => p.url === r.url)) merged.push(r); });
      await chrome.storage.local.set({
        lastScraped: {
          ...base,
          products: merged,
          detailsFetchedAt: new Date().toISOString(),
          enrichmentDone: _enr.done >= _enr.total
        }
      });
    }
  }, 3000);
}

function _notifyBackgroundEnrichDone(results) {
  chrome.storage.local.get('lastScraped').then(prev => {
    const base = prev.lastScraped || {};
    chrome.storage.local.set({
      lastScraped: {
        ...base,
        products: results,
        detailsFetchedAt: new Date().toISOString(),
        enrichmentDone: true
      }
    });
  }).catch(() => {});
  try { chrome.runtime.sendMessage({ action: 'enrichDoneFromContent', products: results }); } catch (_) {}
  setScrapeReportFinal();
}

function startEnrichmentAfterScrape(listingResult) {
  console.log('[scraper] startEnrichmentAfterScrape called, products:', listingResult?.products?.length);
  // Stash the listing result immediately.
  chrome.storage.local.set({ lastScraped: listingResult }).catch(() => {});
  if (!listingResult?.products?.length) return;
  // Kick off iframe enrichment.
  _enrichProductsIframe(listingResult.products, (done, total, currentUrl) => {
    updateScrapeReportProgress(done, total);
    // Save to storage every 20 products.
    if (done % 20 === 0 || done === total) {
      _enrScheduleSave();
    }
  });
}

function abortEnrichment() { _enr.abort = true; _enr.queue = []; }

console.log("[Advice Scraper] Content script loaded");
})();  // end guard IIFE
}  // end duplicate injection guard
