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
    
    // FETCH EVERYTHING (No 'meastypes' filter) to find Visceral Fat
    // if (config.metricList) {
    //    bodyFormData.append('meastypes', config.metricList);
    // }

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
            
            // Proceed to write step to ensure file integrity
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
        
        // DEBUG: Log the first group to help find Visceral Fat ID
        if(scaleData.measuregrps.length > 0) {
             console.log("--- DEBUG: First Measurement Group Data ---");
             scaleData.measuregrps[0].measures.forEach(m => {
                 let mapped = config.metrics[m.type] || "UNKNOWN";
                 let rawVal = m.value * Math.pow(10, m.unit);
                 console.log(`ID: ${m.type} | Value: ${rawVal} | Mapped To: ${mapped}`);
             });
             console.log("-------------------------------------------");
        }

        scaleData.measuregrps.forEach(grp => {
            grp.measures.forEach(measure => {
                let singleEntry = { date: grp.date };
                let metricName = config.metrics[measure.type];
                
                if (metricName) {
                    let val = measure.value * Math.pow(10, measure.unit);

                    // === LOGIC RESTORATION ===
                    
                    // 1. Body Fat Correction (+3%)
                    if (metricName === "Body Fat (%)") {
                        val = val + 3;
                    }

                    // 2. AFib Interpretation
                    if (metricName === "AFib Status") {
                        if ([2, 4].includes(val)) val = "AFib Detected";
                        else if ([0, 1, 5, 10].includes(val)) val = "AFib Not Detected";
                        else val = "Inconclusive";
                    }

                    singleEntry[metricName] = val;

                    // 3. BMI Calculation
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

function formatRow(item) {
    let d = new Date(item.date * 1000);
    let formattedDate = d.toISOString().replace('T', ' ').substring(0, 19);
    
    // Formatting numbers
    let bmi = item["BMI"] ? item["BMI"].toFixed(1) : "";
    let bf = typeof item["Body Fat (%)"] === 'number' ? item["Body Fat (%)"].toFixed(2) : (item["Body Fat (%)"] || "");
    let visceral = item["Visceral Fat Rating"] || "";
    let pwv = typeof item["Pulse Wave Velocity (m/s)"] === 'number' ? item["Pulse Wave Velocity (m/s)"].toFixed(2) : (item["Pulse Wave Velocity (m/s)"] || "");
    
    return `${formattedDate},${item["Weight (kg)"]||""},${bmi},${bf},${visceral},${pwv},${item["AFib Status"]||""},${item["Vascular Age (years)"]||""},${item["Nerve Health Score"]||""}`;
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
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'text' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : "";
        } else {
            console.log("File not found on Drive. Creating new file.");
        }

        let allRowsMap = new Map();

        // Parse Existing
        if (fileContent && fileContent.trim().length > 0) {
            let lines = fileContent.split(/\r?\n/).filter(line => line.trim().length > 0);
            lines.forEach(line => {
                if (line.startsWith("date,")) return;
                let parts = line.split(',');
                let dateStr = parts[0];
                if (dateStr) allRowsMap.set(dateStr, line);
            });
        }

        // Merge New Data
        mergedData.forEach(item => {
            let rowStr = formatRow(item);
            let dateStr = rowStr.split(',')[0];
            allRowsMap.set(dateStr, rowStr);
        });

        // Sort
        let sortedDates = Array.from(allRowsMap.keys()).sort((a, b) => new Date(b) - new Date(a));

        // Reconstruct
        let fullCSV = headerRow + "\n";
        sortedDates.forEach(date => fullCSV += allRowsMap.get(date) + "\n");

        // Write
        if (fileId) {
            await drive.files.update({ fileId: fileId, media: { mimeType: 'text/csv', body: fullCSV } });
            console.log("Successfully overwrote Drive file with cleaned & sorted data.");
        } else {
            await drive.files.create({ requestBody: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: fullCSV } });
            console.log("Successfully created new cleaned CSV on Drive.");
        }

    } catch (error) { console.log("Drive Error:", error.message); }
}

async function persistData(mergedData) {
    if (mergedData.length === 0) return;

    // 1. Save to Local CSV
    if (!fs.existsSync(config.csv_output_path)) {
        fs.writeFileSync(config.csv_output_path, "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score\n");
    }

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

    // 2. Save to Google Drive
    await writeCSVToDrive(mergedData);
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, processData, persistData };
