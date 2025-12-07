import { BLOCKS, INLINES } from "@contentful/rich-text-types";
import type { Document } from "@contentful/rich-text-types";

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

// Create render options based on document structure
export function createRenderOptions(doc: Document) {
  const embeddedAssets = findEmbeddedAssets(doc);
  const totalAssets = embeddedAssets.length;
  let assetIndex = 0;

  return {
    renderNode: {
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
      [INLINES.EMBEDDED_ENTRY]: (node: any) => {
        const entry = node.data.target;
        
        if (!entry || !entry.fields) {
          return "";
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
        
        return "";
      },
    },
    renderMark: {
      bold: (text: string) => `<strong>${text}</strong>`,
      italic: (text: string) => `<em>${text}</em>`,
      underline: (text: string) => `<u>${text}</u>`,
      code: (text: string) => `<code style="background-color: #f1f5f9; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace;">${text}</code>`,
    },
  };
}

// Legacy export - for backward compatibility, this uses a simple float:right approach
// For smart positioning based on image aspect ratio and position, use createRenderOptions() instead
export const renderOptions = {
  renderNode: {
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
  },
  renderMark: {
    bold: (text: string) => `<strong>${text}</strong>`,
    italic: (text: string) => `<em>${text}</em>`,
    underline: (text: string) => `<u>${text}</u>`,
    code: (text: string) => `<code style="background-color: #f1f5f9; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace;">${text}</code>`,
  },
};

// You can also export additional render options for different use cases
// For example, a version without floating images for card layouts:
export const cardRenderOptions = {
  renderNode: {
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
  },
  renderMark: {
    bold: (text: string) => `<strong>${text}</strong>`,
    italic: (text: string) => `<em>${text}</em>`,
    underline: (text: string) => `<u>${text}</u>`,
    code: (text: string) => `<code style="background-color: #f1f5f9; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace;">${text}</code>`,
  },
};