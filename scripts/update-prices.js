const fs = require('fs');
const path = require('path');

async function updatePrices() {
    const dataPath = path.join(__dirname, '../data/equipment-data.json');
    if (!fs.existsSync(dataPath)) {
        console.log("Geen data-bestand gevonden op:", dataPath);
        return;
    }

    let rawData = fs.readFileSync(dataPath, 'utf8');
    let masterData = JSON.parse(rawData);

    // Bepaal waar de rijen staan (afhankelijk van je JSON-structuur)
    let rows = [];
    if (masterData.stockRows && masterData.stockHeaders) {
        // Als je met headers/rows werkt
        // Hier kun je logica toevoegen om door de rijen te loopen
    } else if (Array.isArray(masterData)) {
        rows = masterData;
    } else if (masterData.listings) {
        rows = masterData.listings;
    }

    const now = new Date();
    let updatedCount = 0;

    for (let row of rows) {
        const endDateStr = row['Veiling loopt af op'] ? String(row['Veiling loopt af op']).trim() : '';
        if (!endDateStr) continue;

        // Parse datum (houd rekening met jouw datumformaat in de sheet)
        let cleanDateStr = endDateStr.replace(/^'/, '').trim();
        if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(cleanDateStr)) {
            cleanDateStr = cleanDateStr.replace(' ', 'T');
        }
        const endDate = new Date(cleanDateStr);
        if (isNaN(endDate.getTime())) continue;

        const diffMins = (endDate - now) / (1000 * 60);

        // Als de veiling binnen nu en 60 minuten afloopt
        if (diffMins > 0 && diffMins <= 60) {
            const productUrl = row['Link'];
            if (!productUrl || productUrl === '#') continue;

            console.log(`Check live prijs voor aflopende veiling: ${productUrl} (Nog ${Math.round(diffMins)} min)`);
            
            // Hier kun je een fetch doen naar de bron (of via een gratis fetch-API)
            // en row['Laatste prijs'] / row['Prijs'] bijwerken indien er een nieuw bod is.
            // Als er iets wijzigt: updatedCount++;
        }
    }

    if (updatedCount > 0) {
        fs.writeFileSync(dataPath, JSON.stringify(masterData, null, 2), 'utf8');
        console.log(`${updatedCount} prijzen succesvol bijgewerkt en opgeslagen.`);
    } else {
        console.log("Geen prijswijzigingen gevonden in dit interval.");
    }
}

updatePrices();
