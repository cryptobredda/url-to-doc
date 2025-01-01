const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');

// Set to store visited URLs to avoid duplicates
const visitedUrls = new Set();

function sanitizeHTML(html) {
    const $ = cheerio.load(html);
    
    // Remove script and style elements
    $('script').remove();
    $('style').remove();
    
    // Process the content while maintaining structure
    function extractText(element) {
        let text = '';
        
        $(element).contents().each((_, node) => {
            if (node.type === 'text') {
                // Preserve whitespace in text nodes
                text += node.data.replace(/\s+/g, ' ');
            } else if (node.type === 'tag') {
                const tag = node.tagName.toLowerCase();
                const innerText = extractText(node);
                
                // Handle different tags appropriately
                switch (tag) {
                    case 'p':
                        text += `\n\n${innerText}\n\n`;
                        break;
                    case 'br':
                        text += '\n';
                        break;
                    case 'h1':
                        text += `\n\n# ${innerText}\n\n`;
                        break;
                    case 'h2':
                        text += `\n\n## ${innerText}\n\n`;
                        break;
                    case 'h3':
                        text += `\n\n### ${innerText}\n\n`;
                        break;
                    case 'h4':
                        text += `\n\n#### ${innerText}\n\n`;
                        break;
                    case 'li':
                        text += `\n- ${innerText}`;
                        break;
                    case 'pre':
                    case 'code':
                        text += `\n\`\`\`\n${innerText}\n\`\`\`\n`;
                        break;
                    case 'div':
                        text += `\n${innerText}\n`;
                        break;
                    default:
                        text += innerText;
                }
            }
        });
        
        return text;
    }
    
    let text = extractText('body');
    
    // Clean up excessive newlines while preserving intentional spacing
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

function getPageTitle($) {
    // Try to get the most relevant title
    const h1 = $('h1').first().text().trim();
    const title = $('title').text().trim();
    const metaTitle = $('meta[property="og:title"]').attr('content');
    
    return h1 || title || metaTitle || 'index';
}

function sanitizeFilename(name) {
    // Remove invalid characters and replace with dashes
    return name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function createOutputPath(url, title) {
    const urlObj = new URL(url);
    // Create base folder name from domain
    const baseFolder = sanitizeFilename(urlObj.hostname.replace(/^www\./, ''));
    
    // Create file name from title or path
    let fileName = title ? sanitizeFilename(title) : 'index';
    if (fileName === 'index' && urlObj.pathname !== '/') {
        // Use path segments for filename if no title
        fileName = sanitizeFilename(urlObj.pathname.split('/').filter(Boolean).join('-')) || 'index';
    }
    
    return {
        folder: baseFolder,
        fileName: `${fileName}.md`
    };
}

async function ensureDirectoryExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

async function fetchHTML(url) {
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox']
        });
        const page = await browser.newPage();
        
        // Navigate to the page and wait for network to be idle
        await page.goto(url, { 
            waitUntil: ['networkidle0', 'domcontentloaded'],
            timeout: 30000
        });
        
        // Wait for any dynamic content
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get the rendered HTML
        const html = await page.evaluate(() => document.documentElement.outerHTML);
        
        await browser.close();
        return html;
    } catch (error) {
        console.error(`Error fetching ${url}:`, error.message);
        return null;
    }
}

function extractUrls(html, baseUrl) {
    const $ = cheerio.load(html);
    const urls = new Set();
    const baseUrlObj = new URL(baseUrl);
    
    // Find all anchor tags (focusing on navigation links)
    $('a[href]').each((_, element) => {
        let href = $(element).attr('href');
        if (!href) return;
        
        // Skip certain types of links
        if (href.startsWith('#') || 
            href.startsWith('javascript:') || 
            href.startsWith('mailto:') ||
            href.startsWith('tel:')) {
            return;
        }

        // Skip asset files and static content
        if (href.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf|eot)$/i) ||
            href.includes('/_next/') ||
            href.includes('/static/')) {
            return;
        }

        try {
            let finalUrl;
            if (href.startsWith('http')) {
                finalUrl = href;
            } else if (href.startsWith('//')) {
                finalUrl = `${baseUrlObj.protocol}${href}`;
            } else if (href.startsWith('/')) {
                finalUrl = `${baseUrlObj.origin}${href}`;
            } else {
                finalUrl = new URL(href, baseUrl).toString();
            }

            // Only add URLs from the same domain
            const urlObj = new URL(finalUrl);
            if (urlObj.hostname === baseUrlObj.hostname) {
                console.log('Found URL:', finalUrl);
                urls.add(finalUrl);
            }
        } catch (error) {
            console.error(`Error processing URL ${href}:`, error.message);
        }
    });
    
    return Array.from(urls);
}

async function crawlUrl(startUrl, outputDir, isRoot = true) {
    if (visitedUrls.has(startUrl)) {
        return;
    }
    
    console.log(`Crawling: ${startUrl}`);
    visitedUrls.add(startUrl);
    
    const html = await fetchHTML(startUrl);
    if (!html) return;
    
    const $ = cheerio.load(html);
    const title = getPageTitle($);
    const sanitizedText = sanitizeHTML(html);
    
    // Create output path
    const { folder, fileName } = createOutputPath(startUrl, title);
    const fullOutputDir = path.join(outputDir, folder);
    await ensureDirectoryExists(fullOutputDir);
    
    // Save the content
    const filePath = path.join(fullOutputDir, fileName);
    const content = `# ${title}\n\nSource: ${startUrl}\n\n${sanitizedText}`;
    await fs.writeFile(filePath, content);
    console.log(`Saved: ${filePath}`);
    
    // Only crawl sub-pages if this is the root URL
    if (isRoot) {
        const urls = extractUrls(html, startUrl);
        
        // Process all URLs in parallel
        await Promise.all(
            urls.map(url => crawlUrl(url, outputDir, false))
        );
    }
}

async function main() {
    const startUrl = process.argv[2];
    if (!startUrl) {
        console.error('Please provide a URL as an argument');
        process.exit(1);
    }
    
    const outputDir = process.argv[3] || '.';
    
    console.log('Starting crawler...');
    await crawlUrl(startUrl, outputDir);
    console.log('Crawling completed.');
}

main().catch(console.error);
