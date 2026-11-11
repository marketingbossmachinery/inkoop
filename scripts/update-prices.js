const fs = require('fs');
const path = require('path');

// Wisselkoersen (overgenomen uit je Google Sheets script)
const RATES = {
    SEK: 0.088,
    NOK: 0.086,
    DKK: 0.134,
    USD: 0.90,
    GBP: 1.18,
    JPY: 0.0061,
    CNY: 0.13,
    PLN: 0.235
};

function parseNum(val) {
    if (!val) return NaN;
    let str = String(val).toLowerCase();
    if (str.includes("aanvraag") || str.includes("disclosed") || str.includes("poa") || str.includes("bieden")) return NaN;
    let clean = str.replace(/[^0-9.,]/g, '');
    if (!clean) return NaN;
    
    if (clean.includes('.') && clean.includes(',')) {
        clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (clean.includes(',')) {
        let parts = clean.split(',');
        if (parts.length === 2 && parts[1].length === 2) {
            clean = clean.replace(',', '.');
        } else {
            clean = clean.replace(/,/g, '');
        }
    } else if (clean.includes('.')) {
        let parts = clean.split('.');
        if (parts.length === 2 && parts[1].length === 2) {
            // decimalen
        } else {
            clean = clean.replace(/\./g, '');
        }
    }
    return parseFloat(clean);
}

function formatDutchCurrency(num) {
    if (isNaN(num) || num <= 0) return "Op aanvraag";
    var formatted = num.toFixed(2);
    var parts = formatted.split('.');
    var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    var decPart = parts[1];
    return "€ " + intPart + "," + decPart;
}

// Platform-specifieke prijs-extractie op basis van de meegeleverde scraper logica
async function fetchLivePrice(url, platform) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8'
            }
        });
        if (!response.ok) return null;
        const html = await response.text();
        
        let rawPriceText = null;
        const pLower = (platform || '').toLowerCase();
        const uLower = (url || '').toLowerCase();

        // 1. Troostwijk / Surplex logica ([data-cy="bid-text"], .current-bid)
        if (pLower.includes('troostwijk') || pLower.includes('surplex')) {
            const matchBid = html.match(/data-cy="bid-text"[^>]*>([^<]+)</i) || html.match(/class="[^"]*current-bid[^"]*"[^>]*>([^<]+)</i);
            if (matchBid) rawPriceText = matchBid[1];
        }
        // 2. Proxibid logica (.lotStatusValue)
        else if (pLower.includes('proxibid')) {
            const matchProxy = html.match(/class="[^"]*lotStatusValue[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            if (matchProxy) rawPriceText = matchProxy[1].replace(/<[^>]+>/g, '');
        }
        // 3. AuctionTime / Sandhills logica (.auction-price)
        else if (pLower.includes('auctiontime')) {
            const matchAt = html.match(/class="[^"]*auction-price[^"]*"[^>]*>([^<]+)</i);
            if (matchAt) rawPriceText = matchAt[1];
        }
        // 4. Klaravik logica (.product_card__current-bid of object-information)
        else if (pLower.includes('klaravik') || uLower.includes('klaravik')) {
            const matchKl = html.match(/class="[^"]*product_card__current-bid[^"]*"[^>]*>([^<]+)</i);
            if (matchKl) rawPriceText = matchKl[1];
        }
        // 5. Legal Brokers logica (.item-detail-price-figure)
        else if (pLower.includes('legal brokers') || uLower.includes('legalbrokers')) {
            const matchLb = html.match(/class="[^"]*item-detail-price-figure[^"]*"[^>]*>([^<]+)</i);
            if (matchLb) rawPriceText = matchLb[1];
        }
        // 6. Generieke fallback: zoek naar typische prijsindicaties in HTML
        if (!rawPriceText) {
            const genericMatch = html.match(/(?:€|\$|USD|EUR)\s*([\d\.,]+)/i);
            if (genericMatch) rawPriceText = genericMatch[0];
        }

        if (!rawPriceText) return null;
        return parseNum(rawPriceText);

    } catch (e) {
        console.error(`Fout bij ophalen URL ${url}:`, e.message);
        return null;
    }
}

async function updatePrices() {
    const dataPath = path.join(__dirname, '../data/equipment-data.json');
    if (!fs.existsSync(dataPath)) {
        console.log("Geen data-bestand gevonden op:", dataPath);
        return;
    }

    let rawData = fs.readFileSync(dataPath, 'utf8');
    let masterData;
    try {
        masterData = JSON.parse(rawData);
    } catch (e) {
        console.error("Fout bij parsen JSON:", e);
        return;
    }

    let rows = Array.isArray(masterData) ? masterData : (masterData.listings || masterData.stockRows || []);
    const now = new Date();
    let updatedCount = 0;

    for (let row of rows) {
        // Alleen checken als het een actieve veiling is met een geldige eindtijd
        const veilingCheck = String(row['veiling_loop_af_op'] || row['Veiling loopt af op'] || '').trim();
        const isVeiling = (veilingCheck !== "" && veilingCheck !== "null" && veilingCheck !== "-" && veilingCheck !== "N.v.t." && veilingCheck !== "'-");
        if (!isVeiling) continue;

        let cleanDateStr = veilingCheck.replace(/^'/, '').trim();
        if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(cleanDateStr)) {
            cleanDateStr = cleanDateStr.replace(' ', 'T');
        }
        const endDate = new Date(cleanDateStr);
        if (isNaN(endDate.getTime())) continue;

        const diffMins = (endDate - now) / (1000 * 60);

        // Alleen actie binnen het venster van 60 minuten tot sluiting
        if (diffMins > 0 && diffMins <= 60) {
            const productUrl = row['link'] || row['Link'];
            const platformName = row['platform'] || row['Platform'] || '';
            if (!productUrl || productUrl === '#') continue;

            console.log(`Check live prijs voor aflopende veiling (${platformName}): ${productUrl} (Nog ${Math.round(diffMins)} min)`);
            
            const nieuwBedrag = await fetchLivePrice(productUrl, platformName);
            const huidigePrijsField = row['eerste_prijs'] || row['Prijs'] || '';
            const oudBedrag = parseNum(huidigePrijsField);

            if (!isNaN(nieuwBedrag) && nieuwBedrag > 0) {
                // Veiligheid: Bod kan alleen stijgen of gelijk blijven bij veilingen
                if (!isNaN(oudBedrag) && oudBedrag > 0) {
                    if (nieuwBedrag < oudBedrag) {
                        console.log(`[BLOCKED] Nieuwe prijs (${nieuwBedrag}) is lager dan oud bedrag (${oudBedrag}). Geen update.`);
                        continue;
                    }
                    // Veiligheid: Geen bizarre uitschieters / scraperfouten (> 5x zo hoog)
                    if (nieuwBedrag > (oudBedrag * 5) && oudBedrag > 1000) {
                        console.log(`[BLOCKED] Verdachte prijssprong (${oudBedrag} -> ${nieuwBedrag}). Geëist als foutieve data.`);
                        continue;
                    }
                }

                const geformatteerdePrijs = formatDutchCurrency(nieuwBedrag);
                if (geformatteerdePrijs !== huidigePrijsField) {
                    row['laatste_prijs'] = geformatteerdePrijs;
                    row['laatst_bijgewerkt'] = new Date().toISOString().split('T')[0];
                    row['status'] = "Bod Verhoogd";
                    updatedCount++;
                    console.log(`[SUCCESS] Prijs bijgewerkt van ${huidigePrijsField} naar ${geformatteerdePrijs}`);
                }
            }
        }
    }

    if (updatedCount > 0) {
        fs.writeFileSync(dataPath, JSON.stringify(masterData, null, 2), 'utf8');
        console.log(`${updatedCount} prijzen succesvol bijgewerkt via platform-specifieke scraping.`);
    } else {
        console.log("Geen prijswijzigingen gevonden binnen dit uursvenster.");
    }
}

updatePrices();
