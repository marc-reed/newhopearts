import { BLOCKS, INLINES } from "@contentful/rich-text-types";
import type { Document } from "@contentful/rich-text-types";
import * as XLSX from "xlsx";

function getScaledDimensions(width: number, height: number, max: number = 400) {
  if (width <= max && height <= max) return { width, height };
  const aspectRatio = width / height;
  if (aspectRatio > 1) {
    return { width: max, height: Math.round(max / aspectRatio) };
  } else {
    return { width: Math.round(max * aspectRatio), height: max };
  }
}

// Helper function to find all embedded assets in a document
function findEmbeddedAssets(doc: Document): any[] {
  const assets: any[] = [];
  
  function traverse(node: any) {
    if (node.nodeType === BLOCKS.EMBEDDED_ASSET) {
      assets.push(node);
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child: any) => traverse(child));
    }
  }
  
  traverse(doc);
  return assets;
}

// Helper function to find all imageSlideshow entries
function findImageSlideshowEntries(doc: Document): any[] {
  const entries: any[] = [];
  
  function traverse(node: any) {
    if (node.nodeType === 'embedded-entry-inline' && 
        node.data?.target?.sys?.contentType?.sys?.id === 'imageSlideshow') {
      entries.push(node.data.target);
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child: any) => traverse(child));
    }
  }
  
  traverse(doc);
  return entries;
}

function findSpreadsheetToListEntries(doc: Document): any[] {
  const entries: any[] = [];

  function traverse(node: any) {
    if (
      node.nodeType === 'embedded-entry-inline' &&
      node.data?.target?.sys?.contentType?.sys?.id === 'spreadSheetToList'
    ) {
      entries.push(node.data.target);
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child: any) => traverse(child));
    }
  }

  traverse(doc);
  return entries;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, '');
}

function getRowValue(row: Record<string, unknown>, keys: string[]): string {
  const normalizedCandidates = keys.map(normalizeKey);

  for (const [key, value] of Object.entries(row)) {
    if (normalizedCandidates.includes(normalizeKey(key))) {
      return String(value ?? '').trim();
    }
  }

  return '';
}

async function buildSpreadsheetMarkupByEntryId(doc: Document): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const entries = findSpreadsheetToListEntries(doc);

  for (const entry of entries) {
    const entryId = entry?.sys?.id;
    if (!entryId || result.has(entryId)) {
      continue;
    }

    if (entry?.fields?.type !== 'LastNameFirstNameUrl') {
      result.set(entryId, '');
      continue;
    }

    const spreadsheetAsset = entry?.fields?.spreadsheet;
    if (
      spreadsheetAsset?.sys?.type !== 'Asset' ||
      !spreadsheetAsset?.fields?.file?.url
    ) {
      result.set(entryId, '');
      continue;
    }

    const spreadsheetUrl = `https:${spreadsheetAsset.fields.file.url}`;

    try {
      const response = await fetch(spreadsheetUrl);
      if (!response.ok) {
        result.set(entryId, '');
        continue;
      }

      const buffer = await response.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];

      if (!firstSheetName) {
        result.set(entryId, '');
        continue;
      }

      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
        defval: '',
      });

      if (!rows.length) {
        result.set(entryId, '');
        continue;
      }

      const people = rows
        .map((row) => {
          const firstName = getRowValue(row, ['FirstName', 'First Name']);
          const lastName = getRowValue(row, ['LastName', 'Last Name']);
          const url = getRowValue(row, ['URL', 'Url']);

          return {
            firstName,
            lastName,
            url,
            fullName: `${firstName} ${lastName}`.trim(),
          };
        })
        .filter((person) => person.fullName.length > 0)
        .sort((a, b) => a.lastName.localeCompare(b.lastName, undefined, { sensitivity: 'base' }));

      if (!people.length) {
        result.set(entryId, '');
        continue;
      }

      const listItems = people
        .map((person) => {
          const escapedName = escapeHtml(person.fullName);
          if (person.url) {
            return `<li><a href="${escapeHtml(person.url)}" target="_blank" rel="noopener noreferrer">${escapedName}</a></li>`;
          }
          return `<li>${escapedName}</li>`;
        })
        .join('');

      const listClassName = `spreadsheet-list-${entryId}`;

      result.set(
        entryId,
        `<style>
          .${listClassName} {
            display: grid;
            grid-template-columns: 1fr;
            gap: 0.25rem 1.5rem;
            list-style: disc;
            padding-left: 1.5rem;
            margin: 0;
          }
          @media (min-width: 768px) {
            .${listClassName} {
              grid-template-columns: repeat(2, minmax(0, 1fr));
            }
          }
          @media (min-width: 1024px) {
            .${listClassName} {
              grid-template-columns: repeat(3, minmax(0, 1fr));
            }
          }
        </style>
        <ul class="${listClassName}">${listItems}</ul>`
      );
    } catch {
      result.set(entryId, '');
    }
  }

  return result;
}

// Create render options based on document structure
export async function createRenderOptions(doc: Document) {
  const embeddedAssets = findEmbeddedAssets(doc);
  const totalAssets = embeddedAssets.length;
  let assetIndex = 0;
  let h3Count = 0;
  const spreadsheetMarkupByEntryId = await buildSpreadsheetMarkupByEntryId(doc);

  const renderH3 = (content: string, extraStyles: string = '') => {
    const marginTopStyle = h3Count === 0 ? '' : 'margin-top:0.5rem;';
    h3Count += 1;
    return `<h3 style="${marginTopStyle}${extraStyles}">${content}</h3>`;
  };
  
  // Find all imageSlideshow entries and render them as a grid at the start
  const slideshowEntries = findImageSlideshowEntries(doc);
  let slideshowGrid = '';
  let slideshowGridRendered = false;
  
  if (slideshowEntries.length > 0) {
    slideshowGrid = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.5rem;margin:2rem 0;">';
    
    slideshowEntries.forEach((entry: any) => {
      const imageUrl = entry.fields.image?.fields?.file?.url ? `https:${entry.fields.image.fields.file.url}?w=300&h=300` : '';
      const title = entry.fields.title || '';
      const briefDescription = entry.fields.briefDescription || '';
      const slug = entry.sys.id;
      
      slideshowGrid += `
        <a href="/slideshow/${slug}" style="text-decoration:none;color:inherit;display:block;border-radius:0.5rem;overflow:hidden;box-shadow:0 1px 3px 0 rgba(0,0,0,0.1);transition:transform 0.2s,box-shadow 0.2s;background:white;" onmouseover="this.style.transform='translateY(-4px)';this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)'" onmouseout="this.style.transform='translateY(0)';this.style.boxShadow='0 1px 3px 0 rgba(0,0,0,0.1)'">
          ${imageUrl ? `<img src="${imageUrl}" alt="${title}" style="width:100%;height:200px;object-fit:cover;" />` : ''}
          <div style="padding:1.5rem;">
            ${renderH3(title, 'font-size:1.25rem;font-weight:600;margin-bottom:0.5rem;')}
            <p style="color:#6b7280;line-height:1.5;">${briefDescription}</p>
          </div>
        </a>
      `;
    });
    
    slideshowGrid += '</div>';
  }

  return {
    renderNode: {
      [BLOCKS.HEADING_3]: (node: any, next: any) => {
        const content = next ? next(node.content) : '';
        return renderH3(content);
      },
      [BLOCKS.PARAGRAPH]: (node: any, next: any) => {
        // Check if paragraph contains embedded entries/assets
        const hasEmbeddedContent = node.content.some((child: any) => 
          child.nodeType === 'embedded-entry-inline' || 
          child.nodeType === 'embedded-asset-inline'
        );
        
        const content = next ? next(node.content) : '';
        
        // Only convert newlines if there's no embedded content
        if (hasEmbeddedContent) {
          return `<p>${content}</p>`;
        }
        
        return `<p>${content.replace(/\n/g, '<br/>')}</p>`;
      },
      [BLOCKS.QUOTE]: (node: any, next: any) => {
        const content = next ? next(node.content) : '';
        return `<blockquote style="margin:0.5em 0;margin-left:1.5rem;border-left:5px solid #d1d5db;padding-left:1rem;">${content}</blockquote>`;
      },
      [BLOCKS.EMBEDDED_ASSET]: (node: any) => {
        const asset = node.data.target;
        if (!asset || !asset.fields || !asset.fields.file) {
          return "";
        }

        const imageUrl = "https:" + asset.fields.file.url;
        const title = asset.fields.title || "";
        const description = asset.fields.description || "";
        
        // Get image dimensions
        const details = asset.fields.file.details?.image;
        const originalWidth = details?.width || 400;
        const originalHeight = details?.height || 400;
        const isLandscape = originalWidth > originalHeight;
        
        const currentIndex = assetIndex++;
        const isFirst = currentIndex === 0;
        const isLast = currentIndex === totalAssets - 1 && totalAssets > 1;

        // Determine styling based on position and aspect ratio
        let style = "";
        let wrapperStart = "";
        let wrapperEnd = "";

        // Priority order: First image rules take precedence, then last image, then middle
        if (isFirst && isLandscape) {
          // First image and landscape: center it at the top
          const { width, height } = getScaledDimensions(originalWidth, originalHeight, 600);
          style = `max-width:100%;height:auto;display:block;margin:1rem auto;`;
          wrapperStart = `<p style="text-align:center;">`;
          wrapperEnd = `</p>`;
          return `${wrapperStart}<img src="${imageUrl}" alt="${title}" title="${description}" width="${width}" height="${height}" style="${style}" />${wrapperEnd}`;
        } else if (isFirst && !isLandscape) {
          // First image and portrait/square: float right
          const { width, height } = getScaledDimensions(originalWidth, originalHeight, 400);
          style = `float:right;max-width:50%;height:auto;margin:0 0 1rem 1rem;`;
          return `<img src="${imageUrl}" alt="${title}" title="${description}" width="${width}" height="${height}" style="${style}" />`;
        } else if (isLast) {
          // Last image (when there are multiple): always center it below content
          const { width, height } = getScaledDimensions(originalWidth, originalHeight, 600);
          style = `max-width:100%;height:auto;display:block;margin:1rem auto;`;
          wrapperStart = `<p style="text-align:center;">`;
          wrapperEnd = `</p>`;
          return `${wrapperStart}<img src="${imageUrl}" alt="${title}" title="${description}" width="${width}" height="${height}" style="${style}" />${wrapperEnd}`;
        } else {
          // Middle images: float right
          const { width, height } = getScaledDimensions(originalWidth, originalHeight, 400);
          style = `float:right;max-width:50%;height:auto;margin:0 0 1rem 1rem;`;
          return `<img src="${imageUrl}" alt="${title}" title="${description}" width="${width}" height="${height}" style="${style}" />`;
        }
      },
      [BLOCKS.EMBEDDED_ENTRY]: (node: any) => {
        const entry = node.data.target;
        
        if (!entry || !entry.fields) {
          return "";
        }
        
        const contentTypeId = entry.sys.contentType.sys.id;
        console.log(`[BLOCKS.EMBEDDED_ENTRY] Processing contentType: ${contentTypeId}`);
        
        // Handle imageGrid - responsive grid of thumbnail images with lightbox  [BLOCKS_HANDLER]
        if (contentTypeId === 'imageGrid' && entry.fields.image) {
          console.log('🎯 RENDERING IMAGE GRID!');
          const title = entry.fields.title || '';
          const images = Array.isArray(entry.fields.image) ? entry.fields.image : [entry.fields.image];
          const gridId = `image-grid-${entry.sys.id}`;
          
          let gridHtml = ``;
          
          // Add title if present
          if (title) {
            gridHtml += `<h2 style="margin-bottom:1.5rem;">${title}</h2>`;
          }
          
          gridHtml += `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin:2rem 0;">`;
          
          images.forEach((image: any, index: number) => {
            if (image && image.fields && image.fields.file) {
              const imageUrl = `https:${image.fields.file.url}?w=300&h=300&fit=scale`;
              const imageTitle = image.fields.title || '';
              const description = image.fields.description || '';
              
              gridHtml += `
                <div style="cursor:pointer;border-radius:0.5rem;overflow:hidden;box-shadow:0 1px 3px 0 rgba(0,0,0,0.1);transition:transform 0.2s,box-shadow 0.2s;background:#f5f5f5;display:flex;align-items:center;justify-content:center;" 
                     onclick="openLightbox('${gridId}', ${index})"
                     onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.2)'" 
                     onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 1px 3px 0 rgba(0,0,0,0.1)'">
                  <img src="${imageUrl}" alt="${imageTitle}" style="width:100%;height:200px;object-fit:contain;" />
                </div>`;
            }
          });
          
          gridHtml += `</div>`;
          
          // Add lightbox modal
          gridHtml += `
            <div id="lightbox-${gridId}" onclick="closeLightbox('${gridId}')" style="display:none;position:fixed;z-index:9999;left:0;top:0;width:100%;height:100%;background-color:rgba(0,0,0,0.5);cursor:pointer;">
              <span onclick="closeLightbox('${gridId}')" style="position:absolute;top:20px;right:35px;color:#fff;font-size:40px;font-weight:bold;cursor:pointer;z-index:10000;">&times;</span>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;cursor:default;">
                <img id="lightbox-image-${gridId}" src="" alt="" style="max-width:100vw;max-height:100vh;object-fit:contain;" />
                <div id="lightbox-caption-${gridId}" style="color:#fff;padding:0.25rem 0.5rem;font-size:1.125rem;"></div>
              </div>
            </div>
            
            <script>
              window.lightboxData = window.lightboxData || {};
              window.lightboxCurrentIndex = window.lightboxCurrentIndex || {};
              window.lightboxCurrentGridId = window.lightboxCurrentGridId || null;
              
              window.lightboxData['${gridId}'] = ${JSON.stringify(images.map((img: any) => ({
                url: img?.fields?.file?.url ? `https:${img.fields.file.url}` : '',
                title: img?.fields?.title || '',
                description: img?.fields?.description || ''
              })))};
              
              if (!window.openLightbox) {
                window.openLightbox = function(gridId, index) {
                  const data = window.lightboxData[gridId][index];
                  const lightbox = document.getElementById('lightbox-' + gridId);
                  const image = document.getElementById('lightbox-image-' + gridId);
                  const caption = document.getElementById('lightbox-caption-' + gridId);
                  
                  if (lightbox && image && data) {
                    image.src = data.url;
                    image.alt = data.title;
                    caption.textContent = data.title || data.description;
                    lightbox.style.display = 'block';
                    document.body.style.overflow = 'hidden';
                    window.lightboxCurrentIndex[gridId] = index;
                    window.lightboxCurrentGridId = gridId;
                  }
                };
              }
              
              if (!window.nextImage) {
                window.nextImage = function(gridId) {
                  const currentIndex = window.lightboxCurrentIndex[gridId] || 0;
                  const maxIndex = window.lightboxData[gridId].length - 1;
                  const nextIndex = currentIndex < maxIndex ? currentIndex + 1 : 0;
                  window.openLightbox(gridId, nextIndex);
                };
              }
              
              if (!window.prevImage) {
                window.prevImage = function(gridId) {
                  const currentIndex = window.lightboxCurrentIndex[gridId] || 0;
                  const maxIndex = window.lightboxData[gridId].length - 1;
                  const prevIndex = currentIndex > 0 ? currentIndex - 1 : maxIndex;
                  window.openLightbox(gridId, prevIndex);
                };
              }
              
              if (!window.closeLightbox) {
                window.closeLightbox = function(gridId) {
                  const lightbox = document.getElementById('lightbox-' + gridId);
                  if (lightbox) {
                    lightbox.style.display = 'none';
                    document.body.style.overflow = 'auto';
                  }
                };
              }
              
              // Keyboard navigation - only add once
              if (!window.lightboxKeyboardInitialized) {
                window.lightboxKeyboardInitialized = true;
                document.addEventListener('keydown', function(e) {
                  if (window.lightboxCurrentGridId) {
                    if (e.key === 'ArrowRight') {
                      e.preventDefault();
                      window.nextImage(window.lightboxCurrentGridId);
                    } else if (e.key === 'ArrowLeft') {
                      e.preventDefault();
                      window.prevImage(window.lightboxCurrentGridId);
                    } else if (e.key === 'Escape') {
                      window.closeLightbox(window.lightboxCurrentGridId);
                      window.lightboxCurrentGridId = null;
                    }
                  }
                });
                
                // Touch swipe navigation
                let touchStartX = 0;
                document.addEventListener('touchstart', function(e) {
                  if (window.lightboxCurrentGridId) {
                    touchStartX = e.touches[0].clientX;
                  }
                });
                
                document.addEventListener('touchend', function(e) {
                  if (window.lightboxCurrentGridId) {
                    const touchEndX = e.changedTouches[0].clientX;
                    const diffX = touchStartX - touchEndX;
                    const threshold = 50;
                    
                    if (Math.abs(diffX) > threshold) {
                      if (diffX > 0) {
                        window.nextImage(window.lightboxCurrentGridId);
                      } else {
                        window.prevImage(window.lightboxCurrentGridId);
                      }
                    }
                  }
                });
              }
            </script>`;
          
          return gridHtml;
        }
        
        // Handle eCommerce PayPal forms
        if (entry.sys.contentType.sys.id === 'eCommerce') {
          const name = entry.fields.name || '';
          const description = entry.fields.description || '';
          const formattedDescription = String(description).replace(/\\n|\n|\/n/g, '<br/>');
          const slug = entry.fields.slug || '';
          const price = parseFloat(entry.fields.price || 0);
          const salesTax = parseFloat(entry.fields.salesTax || 0);
          const handling = parseFloat(entry.fields.handling || 0);
          
          return `<form action="https://www.paypal.com/cgi-bin/webscr" method="post" target="_blank" style="width:100%;margin:1rem 0 2rem 0;border-bottom:1px solid #d1d5db;padding:1rem 0;">
            <input type="hidden" name="cmd" value="_xclick">
            <input type="hidden" name="business" value="${import.meta.env.PAYPAL_BIZMAIL}">
            <input type="hidden" name="item_name" value="${name}">
            <input type="hidden" name="item_number" value="${slug}">
            <input type="hidden" name="amount" value="${price.toFixed(2)}">
            <input type="hidden" name="tax" value="${salesTax.toFixed(2)}">
            <input type="hidden" name="handling" value="${handling.toFixed(2)}">
            <input type="hidden" name="quantity" value="1">
            <input type="hidden" name="currency_code" value="USD">
            <div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:center;">
              <div style="flex:2 1 18rem;text-align:left;min-width:0;">
                <h4 style="margin:0;font-size:1.125rem;font-weight:600;">${name}</h4>
                ${description ? `<small style="display:block;margin:0.25rem 0 0 0;font-size:0.875rem;color:#64748b;">${formattedDescription}</small>` : ''}
                <h5 style="margin:0.25rem 0 0 0;font-size:1rem;font-weight:500;color:#475569;">$${price.toFixed(2)}</h5>
              </div>
              <div style="flex:1 1 12rem;display:flex;justify-content:flex-end;">
                <button 
                  type="submit"
                  style="background:#303030;color:white;padding:0.75rem 1.25rem;border-radius:0.75rem;font-weight:600;font-size:1rem;border:none;cursor:pointer;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:0.75rem;white-space:nowrap;"
                  onmouseover="this.style.background='#1a1a1a';this.style.transform='scale(1.02)'"
                  onmouseout="this.style.background='#303030';this.style.transform='scale(1)'"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="25" height="25" viewBox="0,0,256,256">
                    <g fill="#ffffff" fill-rule="nonzero" stroke="none" stroke-width="1" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10" stroke-dasharray="" stroke-dashoffset="0" font-family="none" font-weight="none" font-size="none" text-anchor="none" style="mix-blend-mode: normal"><g transform="scale(5.12,5.12)"><path d="M11.40625,2c-1,0 -1.89453,0.6875 -2.09375,1.6875c0,0 -5.89844,27.00781 -7,32.40625c-0.19922,1.10156 0.07422,1.69531 0.375,2.09375c0.39844,0.5 1.01172,0.8125 1.8125,0.8125h7.5l5.90625,-27.1875c0.19922,-1 1.10547,-2.8125 3.90625,-2.8125h16.1875c-1.39844,-4.60156 -5.89453,-7 -10.09375,-7zM22,11.09375l-1.59375,0.3125c-0.30078,0.19922 -0.49219,0.60547 -0.59375,0.90625l-2.40625,11.1875c0.69922,-0.30078 1.38672,-0.40625 2.1875,-0.40625h7.21875c6.39844,0 9.98828,-2.58594 11.1875,-8.1875c0.19922,-1 0.3125,-1.79297 0.3125,-2.59375l-0.125,-1.125v-0.09375zM40.09375,11.3125l0.09375,0.6875c0.10156,1 -0.08203,1.89453 -0.28125,3.09375c-1.39844,6.5 -5.91797,9.8125 -13.21875,9.8125h-7.1875c-1.60156,0 -2.69922,0.69922 -3,2c-0.39844,1.80078 -3.89844,18.29297 -4,18.59375c-0.10156,0.5 0.00781,1.1875 0.40625,1.6875c0.30078,0.39844 0.78125,0.8125 1.78125,0.8125h8c1,0 1.92578,-0.71094 2.125,-1.8125c0.89844,-3.80078 2.08594,-9.57422 2.1875,-9.875c0,-0.10156 0.09375,-0.3125 0.09375,-0.3125h5.3125c7.80078,0 13.69531,-4.6875 15.09375,-12.1875c1,-4.60156 -0.29297,-7.52344 -1.59375,-9.125c-1.80078,-2.30078 -5.11328,-3.375 -5.8125,-3.375z"></path></g></g>
                  </svg>
                  <span>PayPal or Credit Card</span>
                </button>
              </div>
            </div>
          </form>`;
        }
        
        return "";
      },
      [INLINES.HYPERLINK]: (node: any, next: any) => {
        const url = node.data.uri;
        const linkText = next ? next(node.content) : 
                        node.content.map((content: any) => content.value || '').join('');
        
        const isExternal = url && (url.startsWith('http://') || url.startsWith('https://'));
        const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
        
        return `<a href="${url || '#'}"${target}>${linkText}</a>`;
      },
      [INLINES.ENTRY_HYPERLINK]: (node: any, next: any) => {
        const entry = node.data.target;
        const linkText = next ? next(node.content) : 
                        node.content.map((content: any) => content.value || '').join('');
        
        let url = '#';
        if (entry && entry.fields) {
          if (entry.sys.contentType.sys.id === 'blog' && entry.fields.slug) {
            url = `/blog/${entry.fields.slug}`;
          }
        }
        
        return `<a href="${url}">${linkText}</a>`;
      },
      [INLINES.ASSET_HYPERLINK]: (node: any, next: any) => {
        const asset = node.data.target;
        const linkText = next ? next(node.content) : 
                        node.content.map((content: any) => content.value || '').join('');
        
        if (!asset || !asset.fields || !asset.fields.file) {
          return linkText || '';
        }
        
        const assetUrl = "https:" + asset.fields.file.url;
        const description = asset.fields.description || '';
        
        // PDF documents should always open in new tab
        const target = description === 'Pdf document' ? ' target="_blank" rel="noopener noreferrer"' : '';
        
        return `<a href="${assetUrl}"${target}>${linkText}</a>`;
      },
      [INLINES.EMBEDDED_ENTRY]: (node: any) => {
        const entry = node.data.target;
        
        if (!entry || !entry.fields) {
          return "";
        }

        if (entry.sys.contentType.sys.id === 'spreadSheetToList') {
          return spreadsheetMarkupByEntryId.get(entry.sys.id) ?? '';
        }
        
        // Handle embedded videos
        if (entry.sys.contentType.sys.id === 'embeddedVideos' && entry.fields.videoUrl) {
          const videoUrl = entry.fields.videoUrl;
          
          // Extract YouTube video ID from various URL formats
          let videoId = '';
          if (videoUrl.includes('youtube.com/watch?v=')) {
            videoId = videoUrl.split('v=')[1]?.split('&')[0];
          } else if (videoUrl.includes('youtu.be/')) {
            videoId = videoUrl.split('youtu.be/')[1]?.split('?')[0];
          } else if (videoUrl.includes('youtube.com/embed/')) {
            videoId = videoUrl.split('embed/')[1]?.split('?')[0];
          }
          
          if (videoId) {
            return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;margin:1rem 0;">
              <iframe 
                style="position:absolute;top:0;left:0;width:100%;height:100%;" 
                src="https://www.youtube.com/embed/${videoId}" 
                title="${entry.fields.title || 'YouTube video'}"
                frameborder="0" 
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                allowfullscreen>
              </iframe>
            </div>`;
          }
        }
        
        // Handle imageSlideshow - render grid only once on first encounter
        if (entry.sys.contentType.sys.id === 'imageSlideshow') {
          if (!slideshowGridRendered && slideshowGrid) {
            slideshowGridRendered = true;
            return slideshowGrid;
          }
          return ''; // Hide subsequent inline entries
        }
        
        // Handle imageGrid - responsive grid of thumbnail images with lightbox  [INLINES_HANDLER]
        if (entry.sys.contentType.sys.id === 'imageGrid' && entry.fields.image) {
          const title = entry.fields.title || '';
          const images = Array.isArray(entry.fields.image) ? entry.fields.image : [entry.fields.image];
          const gridId = `image-grid-${entry.sys.id}`;
          
          let gridHtml = ``;
          
          // Add title if present
          if (title) {
            gridHtml += renderH3(title, 'margin-bottom:1.5rem;');
          }
          
          gridHtml += `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin:2rem 0;">`;
          
          images.forEach((image: any, index: number) => {
            if (image && image.fields && image.fields.file) {
              const imageUrl = `https:${image.fields.file.url}?w=300&h=300`;
              const imageTitle = image.fields.title || '';
              const description = image.fields.description || '';
              
              gridHtml += `
                <div style="cursor:pointer;border-radius:0.5rem;overflow:hidden;box-shadow:0 1px 3px 0 rgba(0,0,0,0.1);transition:transform 0.2s,box-shadow 0.2s;background:#f5f5f5;display:flex;align-items:center;justify-content:center;" 
                     onclick="openLightbox('${gridId}', ${index})"
                     onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.2)'" 
                     onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 1px 3px 0 rgba(0,0,0,0.1)'">
                  <img src="${imageUrl}" alt="${imageTitle}" style="width:100%;height:200px;object-fit:contain;" />
                </div>`;
            }
          });
          
          gridHtml += `</div>`;
          
          // Add lightbox modal
          gridHtml += `
            <div id="lightbox-${gridId}" onclick="closeLightbox('${gridId}')" style="display:none;position:fixed;z-index:9999;left:0;top:0;width:100%;height:100%;background-color:rgba(0,0,0,0.5);cursor:pointer;">
              <span onclick="closeLightbox('${gridId}')" style="position:absolute;top:20px;right:35px;color:#fff;font-size:40px;font-weight:bold;cursor:pointer;z-index:10000;">&times;</span>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;cursor:default;">
                <img id="lightbox-image-${gridId}" src="" alt="" style="max-width:100vw;max-height:100vh;object-fit:contain;" />
                <div id="lightbox-caption-${gridId}" style="color:#fff;padding:0.25rem 0.5rem;font-size:1.125rem;"></div>
              </div>
            </div>
            
            <script>
              window.lightboxData = window.lightboxData || {};
              window.lightboxCurrentIndex = window.lightboxCurrentIndex || {};
              window.lightboxCurrentGridId = window.lightboxCurrentGridId || null;
              
              window.lightboxData['${gridId}'] = ${JSON.stringify(images.map((img: any) => ({
                url: img?.fields?.file?.url ? `https:${img.fields.file.url}` : '',
                title: img?.fields?.title || '',
                description: img?.fields?.description || ''
              })))};
              
              if (!window.openLightbox) {
                window.openLightbox = function(gridId, index) {
                  const data = window.lightboxData[gridId][index];
                  const lightbox = document.getElementById('lightbox-' + gridId);
                  const image = document.getElementById('lightbox-image-' + gridId);
                  const caption = document.getElementById('lightbox-caption-' + gridId);
                  
                  if (lightbox && image && data) {
                    image.src = data.url;
                    image.alt = data.title;
                    caption.textContent = data.title || data.description;
                    lightbox.style.display = 'block';
                    document.body.style.overflow = 'hidden';
                    window.lightboxCurrentIndex[gridId] = index;
                    window.lightboxCurrentGridId = gridId;
                  }
                };
              }
              
              if (!window.nextImage) {
                window.nextImage = function(gridId) {
                  const currentIndex = window.lightboxCurrentIndex[gridId] || 0;
                  const maxIndex = window.lightboxData[gridId].length - 1;
                  const nextIndex = currentIndex < maxIndex ? currentIndex + 1 : 0;
                  window.openLightbox(gridId, nextIndex);
                };
              }
              
              if (!window.prevImage) {
                window.prevImage = function(gridId) {
                  const currentIndex = window.lightboxCurrentIndex[gridId] || 0;
                  const maxIndex = window.lightboxData[gridId].length - 1;
                  const prevIndex = currentIndex > 0 ? currentIndex - 1 : maxIndex;
                  window.openLightbox(gridId, prevIndex);
                };
              }
              
              if (!window.closeLightbox) {
                window.closeLightbox = function(gridId) {
                  const lightbox = document.getElementById('lightbox-' + gridId);
                  if (lightbox) {
                    lightbox.style.display = 'none';
                    document.body.style.overflow = 'auto';
                  }
                };
              }
              
              // Keyboard navigation - only add once
              if (!window.lightboxKeyboardInitialized) {
                window.lightboxKeyboardInitialized = true;
                document.addEventListener('keydown', function(e) {
                  if (window.lightboxCurrentGridId) {
                    if (e.key === 'ArrowRight') {
                      e.preventDefault();
                      window.nextImage(window.lightboxCurrentGridId);
                    } else if (e.key === 'ArrowLeft') {
                      e.preventDefault();
                      window.prevImage(window.lightboxCurrentGridId);
                    } else if (e.key === 'Escape') {
                      window.closeLightbox(window.lightboxCurrentGridId);
                      window.lightboxCurrentGridId = null;
                    }
                  }
                });
                
                // Touch swipe navigation
                let touchStartX = 0;
                document.addEventListener('touchstart', function(e) {
                  if (window.lightboxCurrentGridId) {
                    touchStartX = e.touches[0].clientX;
                  }
                });
                
                document.addEventListener('touchend', function(e) {
                  if (window.lightboxCurrentGridId) {
                    const touchEndX = e.changedTouches[0].clientX;
                    const diffX = touchStartX - touchEndX;
                    const threshold = 50;
                    
                    if (Math.abs(diffX) > threshold) {
                      if (diffX > 0) {
                        window.nextImage(window.lightboxCurrentGridId);
                      } else {
                        window.prevImage(window.lightboxCurrentGridId);
                      }
                    }
                  }
                });
              }
            </script>`;
          
          return gridHtml;
        }
        
        // Handle eCommerce PayPal forms
        if (entry.sys.contentType.sys.id === 'eCommerce') {
          const name = entry.fields.name || '';
          const description = entry.fields.description || '';
          const formattedDescription = String(description).replace(/\\n|\n|\/n/g, '<br/>');
          const slug = entry.fields.slug || '';
          const amount = parseFloat(entry.fields.price || 0);
          const salesTaxAmount = parseFloat(entry.fields.salesTaxAmount || 0);
          const tax = parseFloat(entry.fields.tax || 0);
          
          return `<form action="https://www.paypal.com/cgi-bin/webscr" method="post" target="_blank" style="width:100%;margin:1rem 0;border-bottom:1px solid #d1d5db;padding:1rem 0;">
            <input type="hidden" name="cmd" value="_xclick">
            <input type="hidden" name="business" value="${import.meta.env.PAYPAL_BIZMAIL}">
            <input type="hidden" name="item_name" value="${name}">
            <input type="hidden" name="item_number" value="${slug}">
            <input type="hidden" name="amount" value="${amount.toFixed(2)}">
            <input type="hidden" name="tax" value="${salesTaxAmount.toFixed(2)}">
            <input type="hidden" name="handling" value="${tax.toFixed(2)}">
            <input type="hidden" name="quantity" value="1">
            <input type="hidden" name="currency_code" value="USD">
            <div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:center;">
              <div style="flex:2 1 18rem;text-align:left;min-width:0;">
                <h4 style="margin:0;font-size:1.125rem;font-weight:600;">${name}</h4>
                ${description ? `<small style="display:block;margin:0.25rem 0 0 0;font-size:0.875rem;color:#64748b;">${formattedDescription}</small>` : ''}
                <h5 style="margin:0.25rem 0 0 0;font-size:1rem;font-weight:500;color:#475569;">$${amount.toFixed(2)}</h5>
              </div>
              <div style="flex:1 1 12rem;display:flex;justify-content:flex-end;">
                <button 
                  type="submit"
                  style="background:#303030;color:white;padding:0.75rem 1.25rem;border-radius:0.75rem;font-weight:600;font-size:1rem;border:none;cursor:pointer;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:0.75rem;white-space:nowrap;"
                  onmouseover="this.style.background='#1a1a1a';this.style.transform='scale(1.02)'"
                  onmouseout="this.style.background='#303030';this.style.transform='scale(1)'"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="25" height="25" viewBox="0,0,256,256">
                    <g fill="#ffffff" fill-rule="nonzero" stroke="none" stroke-width="1" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10" stroke-dasharray="" stroke-dashoffset="0" font-family="none" font-weight="none" font-size="none" text-anchor="none" style="mix-blend-mode: normal"><g transform="scale(5.12,5.12)"><path d="M11.40625,2c-1,0 -1.89453,0.6875 -2.09375,1.6875c0,0 -5.89844,27.00781 -7,32.40625c-0.19922,1.10156 0.07422,1.69531 0.375,2.09375c0.39844,0.5 1.01172,0.8125 1.8125,0.8125h7.5l5.90625,-27.1875c0.19922,-1 1.10547,-2.8125 3.90625,-2.8125h16.1875c-1.39844,-4.60156 -5.89453,-7 -10.09375,-7zM22,11.09375l-1.59375,0.3125c-0.30078,0.19922 -0.49219,0.60547 -0.59375,0.90625l-2.40625,11.1875c0.69922,-0.30078 1.38672,-0.40625 2.1875,-0.40625h7.21875c6.39844,0 9.98828,-2.58594 11.1875,-8.1875c0.19922,-1 0.3125,-1.79297 0.3125,-2.59375l-0.125,-1.125v-0.09375zM40.09375,11.3125l0.09375,0.6875c0.10156,1 -0.08203,1.89453 -0.28125,3.09375c-1.39844,6.5 -5.91797,9.8125 -13.21875,9.8125h-7.1875c-1.60156,0 -2.69922,0.69922 -3,2c-0.39844,1.80078 -3.89844,18.29297 -4,18.59375c-0.10156,0.5 0.00781,1.1875 0.40625,1.6875c0.30078,0.39844 0.78125,0.8125 1.78125,0.8125h8c1,0 1.92578,-0.71094 2.125,-1.8125c0.89844,-3.80078 2.08594,-9.57422 2.1875,-9.875c0,-0.10156 0.09375,-0.3125 0.09375,-0.3125h5.3125c7.80078,0 13.69531,-4.6875 15.09375,-12.1875c1,-4.60156 -0.29297,-7.52344 -1.59375,-9.125c-1.80078,-2.30078 -5.11328,-3.375 -5.8125,-3.375z"></path></g></g>
                  </svg>
                  <span>PayPal or Credit Card</span>
                </button>
              </div>
            </div>
          </form>`;
        }
        
        return "";
      },
    },
    renderMark: {
      bold: (text: string) => `<strong>${text}</strong>`,
      italic: (text: string) => `<em>${text}</em>`,
      underline: (text: string) => `<u>${text}</u>`,
      code: (text: string) => `<code style="background-color: #f1f5f9; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace;">${text}</code>`,
    },
    renderText: (text: string) => text.replace(/\n/g, '<br/>'),
  };
}

// Legacy export - for backward compatibility, this uses a simple float:right approach
// For smart positioning based on image aspect ratio and position, use createRenderOptions() instead
export const renderOptions = {
  renderNode: {
    [BLOCKS.PARAGRAPH]: (node: any, next: any) => {
      // Check if paragraph contains embedded entries/assets
      const hasEmbeddedContent = node.content.some((child: any) => 
        child.nodeType === 'embedded-entry-inline' || 
        child.nodeType === 'embedded-asset-inline'
      );
      
      const content = next ? next(node.content) : '';
      
      // Only convert newlines if there's no embedded content
      if (hasEmbeddedContent) {
        return `<p>${content}</p>`;
      }
      
      return `<p>${content.replace(/\n/g, '<br/>')}</p>`;
    },
    [BLOCKS.QUOTE]: (node: any, next: any) => {
      const content = next ? next(node.content) : '';
      return `<blockquote style="margin:0.5em 0;margin-left:1.5rem;border-left:5px solid #d1d5db;padding-left:1rem;">${content}</blockquote>`;
    },
    [BLOCKS.EMBEDDED_ASSET]: (node: any) => {
      const asset = node.data.target;
      if (asset && asset.fields && asset.fields.file) {
        const imageUrl = "https:" + asset.fields.file.url;
        const title = asset.fields.title || "";
        const description = asset.fields.description || "";
        
        // Get image dimensions if available
        const details = asset.fields.file.details?.image;
        const { width, height } = details ? getScaledDimensions(details.width, details.height) : { width: 400, height: 400 };
        
        return `<img src="${imageUrl}" alt="${title}" title="${description}" width="${width}" height="${height}" style="float:right;max-width:50%;height:auto;margin:0 0 1rem 1rem;" />`;
      }
      return "";
    },
    [INLINES.HYPERLINK]: (node: any, next: any) => {
      const url = node.data.uri;
      const linkText = next ? next(node.content) : 
                      node.content.map((content: any) => content.value || '').join('');
      
      const isExternal = url && (url.startsWith('http://') || url.startsWith('https://'));
      const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      
      return `<a href="${url || '#'}"${target}>${linkText}</a>`;
    },
    [INLINES.ENTRY_HYPERLINK]: (node: any, next: any) => {
      const entry = node.data.target;
      const linkText = next ? next(node.content) : 
                      node.content.map((content: any) => content.value || '').join('');
      
      let url = '#';
      if (entry && entry.fields) {
        if (entry.sys.contentType.sys.id === 'blog' && entry.fields.slug) {
          url = `/blog/${entry.fields.slug}`;
        }
      }
      
      return `<a href="${url}">${linkText}</a>`;
    },
    [INLINES.ASSET_HYPERLINK]: (node: any, next: any) => {
      const asset = node.data.target;
      const linkText = next ? next(node.content) : 
                      node.content.map((content: any) => content.value || '').join('');
      
      if (!asset || !asset.fields || !asset.fields.file) {
        return linkText || '';
      }
      
      const assetUrl = "https:" + asset.fields.file.url;
      const description = asset.fields.description || '';
      
      // PDF documents should always open in new tab
      const target = description === 'Pdf document' ? ' target="_blank" rel="noopener noreferrer"' : '';
      
      return `<a href="${assetUrl}"${target}>${linkText}</a>`;
    },
  },
  renderMark: {
    bold: (text: string) => `<strong>${text}</strong>`,
    italic: (text: string) => `<em>${text}</em>`,
    underline: (text: string) => `<u>${text}</u>`,
    code: (text: string) => `<code style="background-color: #f1f5f9; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace;">${text}</code>`,
  },
  renderText: (text: string) => text.replace(/\n/g, '<br/>'),
};

// You can also export additional render options for different use cases
// For example, a version without floating images for card layouts:
export const cardRenderOptions = {
  renderNode: {
    [BLOCKS.PARAGRAPH]: (node: any, next: any) => {
      // Check if paragraph contains embedded entries/assets
      const hasEmbeddedContent = node.content.some((child: any) => 
        child.nodeType === 'embedded-entry-inline' || 
        child.nodeType === 'embedded-asset-inline'
      );
      
      const content = next ? next(node.content) : '';
      
      // Only convert newlines if there's no embedded content
      if (hasEmbeddedContent) {
        return `<p>${content}</p>`;
      }
      
      return `<p>${content.replace(/\n/g, '<br/>')}</p>`;
    },
    [BLOCKS.QUOTE]: (node: any, next: any) => {
      const content = next ? next(node.content) : '';
      return `<blockquote style="margin:0.5em 0;margin-left:1.5rem;border-left:5px solid #d1d5db;padding-left:1rem;">${content}</blockquote>`;
    },
    [BLOCKS.EMBEDDED_ASSET]: (node: any) => {
      const asset = node.data.target;
      if (asset && asset.fields && asset.fields.file) {
        const imageUrl = "https:" + asset.fields.file.url;
        const title = asset.fields.title || "";
        const description = asset.fields.description || "";
        
        // Get image dimensions if available
        const details = asset.fields.file.details?.image;
        const { width, height } = details ? getScaledDimensions(details.width, details.height, 300) : { width: 300, height: 300 };
        
        return `<img src="${imageUrl}" alt="${title}" title="${description}" width="${width}" height="${height}" style="max-width:100%;height:auto;margin:1rem 0;" />`;
      }
      return "";
    },
    [INLINES.HYPERLINK]: (node: any, next: any) => {
      const url = node.data.uri;
      const linkText = next ? next(node.content) : 
                      node.content.map((content: any) => content.value || '').join('');
      
      const isExternal = url && (url.startsWith('http://') || url.startsWith('https://'));
      const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      
      return `<a href="${url || '#'}"${target}>${linkText}</a>`;
    },
    [INLINES.ENTRY_HYPERLINK]: (node: any, next: any) => {
      const entry = node.data.target;
      const linkText = next ? next(node.content) : 
                      node.content.map((content: any) => content.value || '').join('');
      
      let url = '#';
      if (entry && entry.fields) {
        if (entry.sys.contentType.sys.id === 'blog' && entry.fields.slug) {
          url = `/blog/${entry.fields.slug}`;
        }
      }
      
      return `<a href="${url}">${linkText}</a>`;
    },
    [INLINES.ASSET_HYPERLINK]: (node: any, next: any) => {
      const asset = node.data.target;
      const linkText = next ? next(node.content) : 
                      node.content.map((content: any) => content.value || '').join('');
      
      if (!asset || !asset.fields || !asset.fields.file) {
        return linkText || '';
      }
      
      const assetUrl = "https:" + asset.fields.file.url;
      const description = asset.fields.description || '';
      
      // PDF documents should always open in new tab
      const target = description === 'Pdf document' ? ' target="_blank" rel="noopener noreferrer"' : '';
      
      return `<a href="${assetUrl}"${target}>${linkText}</a>`;
    },
  },
  renderMark: {
    bold: (text: string) => `<strong>${text}</strong>`,
    italic: (text: string) => `<em>${text}</em>`,
    underline: (text: string) => `<u>${text}</u>`,
    code: (text: string) => `<code style="background-color: #f1f5f9; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace;">${text}</code>`,
  },
  renderText: (text: string) => text.replace(/\n/g, '<br/>'),
};