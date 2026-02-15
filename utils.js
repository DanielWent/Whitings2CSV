var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

function getPreviousTimestamp() {
    try {
        let timestamp = fs.readFileSync(config.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) { return 1577836800; } // Default to Jan 1, 2020
}

async function getReplacementAccessToken(refreshToken) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'requesttoken');
    bodyFormData.append('grant_type', 'refresh_token');
    bodyFormData.append('client_id', config.withingsClientID);
    bodyFormData.append('client_secret', config.withingsClientSecret);
    bodyFormData.append('refresh_token', refreshToken);
    try {
        const response = await axios.post("https://wbsapi.withings.net/v2/oauth2", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        if (response.data.body && response.data.body.access_token) {
            storeTokens(response.data.body.access_token, response.data.body.refresh_token);
            return response.data.body.access_token;
        }
    } catch (error) { console.log("Token Refresh Error:", error.message); }
    return null;
}

function storeTokens(accessToken, refreshToken) {
    try { fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken })); } catch (error) { console.log("Error storing tokens", error); }
}

function storeTime(latestTimestamp) {
    try { fs.writeFileSync(config.timestamp_path, JSON.stringify(latestTimestamp)); } catch (error) { console.log("Error storing timestamp", error) }
}

async function getWithingsData(accessToken, refreshToken, currentTime) {
    const startdate = getPreviousTimestamp();
    const enddate = currentTime;

    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    bodyFormData.append('access_token', accessToken);
    bodyFormData.append('startdate', startdate);
    bodyFormData.append('enddate', enddate);
    
    if (config.metricList) {
        bodyFormData.append('meastypes', config.metricList);
    }

    try {
        console.log(`Fetching data from ${new Date(startdate * 1000).toISOString()} to ${new Date(enddate * 1000).toISOString()}...`);
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        
        if (response.data.status === 401) {
            console.log("Access Token Expired. Refreshing...");
            let newAccessToken = await getReplacementAccessToken(refreshToken);
            if (newAccessToken) {
                return await getWithingsData(newAccessToken, refreshToken, currentTime);
            } else {
                console.error("Failed to refresh token.");
                return null;
            }
        }
        
        if (response.data.status === 0) {
            let data = response.data.body;
            let mergedData = await processData(data);
            console.log(`Processed ${mergedData.length} new entries.`);
            
            // Proceed to write step to ensure file integrity (fix bad headers/newlines)
            await persistData(mergedData);
            await storeTime(currentTime);
            
            return data;
        } else {
            console.log("API Error Status:", response.data.status);
            return null;
        }

    } catch (error) {
        console.log("Error getting Withings data:", error.message);
        return null;
    }
}

async function processData(scaleData) {
    let simplifiedData = [];
    if (scaleData && scaleData.measuregrps) {
        scaleData.measuregrps.forEach(grp => {
            grp.measures.forEach(measure => {
                let singleEntry = { date: grp.date };
                let metricName = config.metrics[measure.type];
                
                if (metricName) {
                    let val = measure.value * Math.pow(10, measure.unit);
                    singleEntry[metricName] = val;

                    if (metricName === "Weight (kg)" && config.height) {
                        singleEntry["BMI"] = val / (config.height * config.height);
                    }
                    
                    simplifiedData.push(singleEntry);
                }
            });
        });
    }

    var mergedMap = simplifiedData.filter(function (v) {
        return this[v.date] ? !Object.assign(this[v.date], v) : (this[v.date] = v);
    }, {});
    
    let result = Object.values(mergedMap);
    result.sort((a, b) => b.date - a.date);
    return result;
}

// Helper to format a row from an object
function formatRow(item) {
    let d = new Date(item.date * 1000);
    // Format: YYYY-MM-DD HH:mm:ss
    let formattedDate = d.toISOString().replace('T', ' ').substring(0, 19);
    
    let bmi = item["BMI"] ? item["BMI"].toFixed(1) : "";
    let visceral = item["Visceral Fat Rating"] || "";
    
    return `${formattedDate},${item["Weight (kg)"]||""},${bmi},${item["Body Fat (%)"]||""},${visceral},${item["Pulse Wave Velocity (m/s)"]||""},${item["AFib Status"]||""},${item["Vascular Age (years)"]||""},${item["Nerve Health Score"]||""}`;
}

async function writeCSVToDrive(mergedData) {
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    
    const headerRow = "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score";
    let fileId = null;
    let fileContent = "";

    try {
        const listRes = await drive.files.list({ 
            q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`, 
            fields: 'files(id, name)' 
        });
        
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            console.log(`Found file on Drive: ${config.driveFileName} (ID: ${fileId})`);
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'text' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : "";
        } else {
            console.log("File not found on Drive. Creating new file.");
        }

        // --- ROBUST MERGE STRATEGY ---
        // 1. Parse existing file content into a Map (Date -> Row String)
        // 2. Add/Overwrite with new data from mergedData
        // 3. Sort by Date
        // 4. Rewrite entire file
        
        let allRowsMap = new Map();

        // Step 1: Parse Existing
        if (fileContent && fileContent.trim().length > 0) {
            // Split by newline and remove empty lines
            let lines = fileContent.split(/\r?\n/).filter(line => line.trim().length > 0);
            
            lines.forEach(line => {
                if (line.startsWith("date,")) return; // Skip header
                let parts = line.split(',');
                let dateStr = parts[0];
                if (dateStr) {
                    allRowsMap.set(dateStr, line);
                }
            });
            console.log(`Read ${allRowsMap.size} valid rows from existing Drive file.`);
        }

        // Step 2: Merge New Data
        let newCount = 0;
        mergedData.forEach(item => {
            let rowStr = formatRow(item);
            let dateStr = rowStr.split(',')[0]; // Extract the formatted date "2023-01-01 12:00:00"
            
            if (!allRowsMap.has(dateStr)) {
                newCount++;
            }
            // We set (overwrite) the row to ensure we have the latest format/columns
            allRowsMap.set(dateStr, rowStr);
        });

        console.log(`Merging... Total rows: ${allRowsMap.size} (Updated/New from this run: ${mergedData.length})`);

        // Step 3: Sort
        // Convert Map keys to array, sort descending (newest first)
        let sortedDates = Array.from(allRowsMap.keys()).sort((a, b) => {
            return new Date(b) - new Date(a);
        });

        // Step 4: Reconstruct CSV
        let fullCSV = headerRow + "\n";
        sortedDates.forEach(date => {
            fullCSV += allRowsMap.get(date) + "\n";
        });

        // Step 5: Write to Drive
        // We use 'update' if file exists, 'create' if not.
        // We ALWAYS write if there is data, to fix potential formatting/newline issues in the saved file.
        if (fileId) {
            await drive.files.update({ 
                fileId: fileId, 
                media: { mimeType: 'text/csv', body: fullCSV } 
            });
            console.log("Successfully overwrote Drive file with cleaned & sorted data.");
        } else {
            await drive.files.create({ 
                requestBody: { name: config.driveFileName, parents: [config.driveFolderId] }, 
                media: { mimeType: 'text/csv', body: fullCSV } 
            });
            console.log("Successfully created new cleaned CSV on Drive.");
        }

    } catch (error) { console.log("Drive Error:", error.message); }
}

async function persistData(mergedData) {
    if (mergedData.length === 0) {
        // Even if no new data, we might want to trigger a drive sync to clean the file
        // But usually we need at least some data context.
        // If the user is running a Reset, mergedData has everything. 
        // If incremental, it might be empty.
        // Let's rely on writeCSVToDrive to handle the file check if we pass it an empty array? 
        // No, let's just return if truly empty to save API calls, unless we want to force a fix.
        // For now, let's assume we only sync if we fetched *something*.
        return;
    }

    // 1. Save to Local CSV (Append mode is fine for local logging)
    if (!fs.existsSync(config.csv_output_path)) {
        fs.writeFileSync(config.csv_output_path, "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score\n");
    }

    // We can just append to local for simplicity, or repeat the robust logic.
    // Keeping local simple (append) as it's mostly for debug/backup.
    let existingFileContent = fs.readFileSync(config.csv_output_path, 'utf8');
    let existingDates = new Set();
    existingFileContent.split('\n').forEach(line => {
        let parts = line.split(',');
        if (parts[0] !== 'date') existingDates.add(parts[0]);
    });

    let newLines = "";
    mergedData.forEach(item => {
        let row = formatRow(item);
        let dateStr = row.split(',')[0];
        if (!existingDates.has(dateStr)) {
            newLines += row + "\n";
        }
    });

    if (newLines.length > 0) {
        fs.appendFileSync(config.csv_output_path, newLines);
        console.log("Appended to local CSV.");
    }

    // 2. Save to Google Drive (Robust Overwrite)
    await writeCSVToDrive(mergedData);
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, processData, persistData };
