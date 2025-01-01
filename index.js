const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
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

function sanitizeFilename(url) {
    try {
        const urlObj = new URL(url);
        // Get hostname without www and remove TLD
        let filename = urlObj.hostname.replace(/^www\./, '').split('.')[0];
        
        // Add the first path segment if it exists
        if (urlObj.pathname !== '/' && urlObj.pathname !== '') {
            const pathSegment = urlObj.pathname.split('/')[1];
            if (pathSegment) {
                filename += '-' + pathSegment;
            }
        }
        
        // Remove any invalid filename characters
        filename = filename.replace(/[^a-z0-9-]/gi, '-');
        // Remove multiple consecutive dashes
        filename = filename.replace(/-+/g, '-');
        // Remove leading/trailing dashes
        filename = filename.replace(/^-|-$/g, '');
        
        return filename.toLowerCase();
    } catch (error) {
        console.error('Error processing URL for filename:', error);
        return 'webpage';
    }
}

async function crawlUrl(startUrl, isRoot = true) {
    if (visitedUrls.has(startUrl)) {
        return '';
    }
    
    console.log(`Crawling: ${startUrl}`);
    visitedUrls.add(startUrl);
    
    const html = await fetchHTML(startUrl);
    if (!html) return '';
    
    const sanitizedText = sanitizeHTML(html);
    let allText = `\n\n## Content from ${startUrl}\n\n${sanitizedText}\n\n---\n\n`;
    
    // Only crawl sub-pages if this is the root URL
    if (isRoot) {
        const urls = extractUrls(html, startUrl);
        
        // Process all URLs in parallel for faster crawling
        const subTexts = await Promise.all(
            urls.map(url => crawlUrl(url, false))
        );
        
        allText += subTexts.join('\n');
    }
    
    return allText;
}

async function main() {
    const startUrl = process.argv[2];
    if (!startUrl) {
        console.error('Please provide a URL as an argument');
        process.exit(1);
    }
    
    console.log('Starting crawler...');
    const content = await crawlUrl(startUrl);
    
    const filename = `${sanitizeFilename(startUrl)}.md`;
    await fs.writeFile(filename, content);
    console.log(`Crawling completed. Content saved to ${filename}`);
}

main().catch(console.error);
