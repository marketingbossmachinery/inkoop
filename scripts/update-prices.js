const fs = require('fs');
const path = require('path');

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

        if (pLower.includes('troostwijk') || pLower.includes('surplex')) {
            const matchBid = html.match(/data-cy="bid-text"[^>]*>([^<]+)</i) || html.match(/class="[^"]*current-bid[^"]*"[^>]*>([^<]+)</i);
            if (matchBid) rawPriceText = matchBid[1];
        } else if (pLower.includes('proxibid')) {
            const matchProxy = html.match(/class="[^"]*lotStatusValue[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            if (matchProxy) rawPriceText = matchProxy[1].replace(/<[^>]+>/g, '');
        } else if (pLower.includes('auctiontime')) {
            const matchAt = html.match(/class="[^"]*auction-price[^"]*"[^>]*>([^<]+)</i);
            if (matchAt) rawPriceText = matchAt[1];
        }

        if (!rawPriceText) return null;
        return parseNum(rawPriceText);

    } catch (e) {
        return null;
    }
}

async function updatePrices() {
    const dataPath = path.join(__dirname, '../data/equipment-data.json');
    if (!fs.existsSync(dataPath)) return;

    let rawData = fs.readFileSync(dataPath, 'utf8');
    let masterData = JSON.parse(rawData);
    let rows = Array.isArray(masterData) ? masterData : (masterData.listings || masterData.stockRows || []);
    const now = new Date();
    let updatedCount = 0;

    for (let row of rows) {
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

        // Venster: Tussen 30 minuten en 3 uur voor het einde
        if (diffMins > 30 && diffMins <= 180) {
            const productUrl = row['link'] || row['Link'];
            const platformName = row['platform'] || row['Platform'] || '';
            if (!productUrl || productUrl === '#') continue;

            console.log(`Check live prijs (tussen 30m en 3u): ${productUrl} (Nog ${Math.round(diffMins)} min)`);
            
            const nieuwBedrag = await fetchLivePrice(productUrl, platformName);
            const huidigePrijsField = row['eerste_prijs'] || row['Prijs'] || '';
            const oudBedrag = parseNum(huidigePrijsField);

            if (!isNaN(nieuwBedrag) && nieuwBedrag > 0) {
                // Alleen controleren of het bod niet omlaag is gegaan (een veilingprijs stijgt of blijft gelijk)
                if (!isNaN(oudBedrag) && oudBedrag > 0) {
                    if (nieuwBedrag < oudBedrag) {
                        // Bod kan in een veiling niet opeens lager zijn dan wat er al stond
                        continue; 
                    }
                    
                    // Alleen ingrijpen bij echt bizarre, onlogische uitschieters (bijv. een sprong van € 50 naar € 500.000 in één keer door een foute ID-uitlezing)
                    if (nieuwBedrag > (oudBedrag * 50) && oudBedrag > 500) {
                        console.log(`[BLOCKED] Onrealistische prijssprong gedetecteerd (${oudBedrag} -> ${nieuwBedrag})`);
                        continue;
                    }
                }

                const geformatteerdePrijs = formatDutchCurrency(nieuwBedrag);
                if (geformatteerdePrijs !== huidigePrijsField) {
                    row['laatste_prijs'] = geformatteerdePrijs;
                    row['laatst_bijgewerkt'] = new Date().toISOString().split('T')[0];
                    row['status'] = "Bod Verhoogd";
                    updatedCount++;
                    console.log(`[SUCCESS] Prijs succesvol meegegroeid naar ${geformatteerdePrijs}`);
                }
            }
        }
    }

    if (updatedCount > 0) {
        fs.writeFileSync(dataPath, JSON.stringify(masterData, null, 2), 'utf8');
        console.log(`${updatedCount} prijzen succesvol bijgewerkt.`);
    } else {
        console.log("Geen prijswijzigingen binnen het venster gevonden.");
    }
}

updatePrices();
