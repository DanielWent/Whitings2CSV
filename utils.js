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
            
            // Proceed to write step even if mergedData is empty, to verify file integrity if needed
            if (mergedData.length > 0) {
                await persistData(mergedData);
                await storeTime(currentTime);
            } else {
                console.log("No new data found in this time range.");
            }
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

async function writeCSVToDrive(mergedData) {
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    
    const headerRow = "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score\n";
    let fileId = null;
    let fileContent = "";

    try {
        const listRes = await drive.files.list({ 
            q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`, 
            fields: 'files(id, name, size, modifiedTime)' 
        });
        
        if (listRes.data.files.length > 0) {
            // DUPLICATE CHECK
            if (listRes.data.files.length > 1) {
                console.warn(`[WARNING] Found ${listRes.data.files.length} files named '${config.driveFileName}'. Using the first one.`);
                console.warn(`File 1 ID: ${listRes.data.files[0].id} (Size: ${listRes.data.files[0].size || 0} bytes)`);
                console.warn(`File 2 ID: ${listRes.data.files[1].id} (Size: ${listRes.data.files[1].size || 0} bytes)`);
            }

            fileId = listRes.data.files[0].id;
            console.log(`Targeting Drive File ID: ${fileId}`);
            
            // EXPLICITLY request as text to avoid object confusion
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'text' });
            fileContent = getRes.data;
            
            // DEBUG: Show what we actually got
            if (typeof fileContent === 'string') {
                console.log(`[DEBUG] Downloaded content length: ${fileContent.length} chars.`);
                console.log(`[DEBUG] First 100 chars: "${fileContent.substring(0, 100).replace(/\n/g, '\\n')}"`);
            } else {
                console.log(`[DEBUG] Downloaded content is NOT a string. Type: ${typeof fileContent}`);
                fileContent = ""; 
            }
        } else {
            console.log("File not found on Drive. Creating new file.");
        }

        // Logic: Treat whitespace-only or extremely short files as "empty"
        if (!fileContent || typeof fileContent !== 'string' || fileContent.trim().length < 5) {
            console.log("Drive file deemed EMPTY. Overwriting with Headers + Data.");
            
            let fullBody = headerRow;
            mergedData.forEach(item => {
                let d = new Date(item.date * 1000);
                let formattedDate = d.toISOString().replace('T', ' ').substring(0, 19);
                let bmi = item["BMI"] ? item["BMI"].toFixed(1) : "";
                let visceral = item["Visceral Fat Rating"] || "";
                let row = `${formattedDate},${item["Weight (kg)"]||""},${bmi},${item["Body Fat (%)"]||""},${visceral},${item["Pulse Wave Velocity (m/s)"]||""},${item["AFib Status"]||""},${item["Vascular Age (years)"]||""},${item["Nerve Health Score"]||""}\n`;
                fullBody += row;
            });

            if (fileId) {
                await drive.files.update({ fileId: fileId, media: { mimeType: 'text/csv', body: fullBody } });
            } else {
                await drive.files.create({ requestBody: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: fullBody } });
            }
            console.log("Successfully initialized CSV on Drive.");
            return;
        }

        // --- APPEND LOGIC ---
        console.log("Drive file has content. Merging...");
        
        // Ensure headers exist
        if (!fileContent.startsWith("date,")) {
             console.log("Headers missing in file. Prepending...");
             fileContent = headerRow + fileContent;
        }

        let newContent = "";
        let existingDates = new Set();
        const lines = fileContent.split('\n');
        
        lines.forEach(line => {
            const parts = line.split(',');
            if (parts.length > 0 && parts[0] !== 'date' && parts[0].trim() !== "") {
                existingDates.add(parts[0].trim());
            }
        });

        console.log(`[DEBUG] Parsed ${existingDates.size} existing unique dates from Drive file.`);

        mergedData.forEach(item => {
            let d = new Date(item.date * 1000);
            let formattedDate = d.toISOString().replace('T', ' ').substring(0, 19);

            if (!existingDates.has(formattedDate)) {
                let bmi = item["BMI"] ? item["BMI"].toFixed(1) : "";
                let visceral = item["Visceral Fat Rating"] || "";
                let row = `${formattedDate},${item["Weight (kg)"]||""},${bmi},${item["Body Fat (%)"]||""},${visceral},${item["Pulse Wave Velocity (m/s)"]||""},${item["AFib Status"]||""},${item["Vascular Age (years)"]||""},${item["Nerve Health Score"]||""}\n`;
                newContent += row;
            }
        });

        if (newContent.length > 0) {
            console.log(`Appending ${newContent.split('\n').length - 1} new rows to Drive.`);
            await drive.files.update({ 
                fileId: fileId, 
                media: { mimeType: 'text/csv', body: fileContent + newContent } 
            });
            console.log("Successfully updated CSV on Drive.");
        } else {
            console.log("All data already exists in Drive file. No update needed.");
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
        let d = new Date(item.date * 1000);
        let formattedDate = d.toISOString().replace('T', ' ').substring(0, 19);

        if (!existingDates.has(formattedDate)) {
            let bmi = item["BMI"] ? item["BMI"].toFixed(1) : "";
            let visceral = item["Visceral Fat Rating"] || "";
            
            newLines += `${formattedDate},${item["Weight (kg)"]||""},${bmi},${item["Body Fat (%)"]||""},${visceral},${item["Pulse Wave Velocity (m/s)"]||""},${item["AFib Status"]||""},${item["Vascular Age (years)"]||""},${item["Nerve Health Score"]||""}\n`;
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
