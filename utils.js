var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

// [UPDATED] Accepts user object to find specific timestamp file
function getPreviousTimestamp(user) {
    try {
        let timestamp = fs.readFileSync(user.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) { return 1577836800; } 
}

// [UPDATED] Accepts user object to find specific token file
async function getReplacementAccessToken(refreshToken, user) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'requesttoken');
    bodyFormData.append('grant_type', 'refresh_token');
    bodyFormData.append('client_id', config.withingsClientID);
    bodyFormData.append('client_secret', config.withingsClientSecret);
    bodyFormData.append('refresh_token', refreshToken);
    try {
        const response = await axios.post("https://wbsapi.withings.net/v2/oauth2", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        if (response.data.body && response.data.body.access_token) {
            storeTokens(response.data.body.access_token, response.data.body.refresh_token, user);
            return response.data.body.access_token;
        }
    } catch (error) { console.log("Token Refresh Error:", error.message); }
    return null;
}

// [UPDATED] Accepts user object
function storeTokens(accessToken, refreshToken, user) {
    try { fs.writeFileSync(user.token_path, JSON.stringify({ accessToken, refreshToken })); } catch (error) { console.log("Error storing tokens", error); }
}

// [UPDATED] Accepts user object
function storeTime(latestTimestamp, user) {
    try { fs.writeFileSync(user.timestamp_path, JSON.stringify(latestTimestamp)); } catch (error) { console.log("Error storing timestamp", error) }
}

// [UPDATED] Accepts user object
async function getWithingsData(accessToken, refreshToken, currentTime, user) {
    const startdate = getPreviousTimestamp(user);
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    bodyFormData.append('access_token', accessToken);
    bodyFormData.append('startdate', startdate);
    bodyFormData.append('enddate', currentTime);
    
    try {
        console.log(`Fetching metrics for ${user.id}...`);
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        
        if (response.data.status === 401) {
            let newAccessToken = await getReplacementAccessToken(refreshToken, user);
            if (newAccessToken) return await getWithingsData(newAccessToken, refreshToken, currentTime, user);
            return null;
        }
        
        if (response.data.status === 0) {
            // Pass user to processData for height calculation
            let mergedData = await processData(response.data.body, user);
            await persistData(mergedData, user);
            await storeTime(currentTime, user);
            return response.data.body;
        }
    } catch (error) { console.log("API Error:", error.message); return null; }
}

// [UPDATED] Accepts user object
async function processData(scaleData, user) {
    let dataByDate = new Map();

    if (scaleData && scaleData.measuregrps) {
        scaleData.measuregrps.forEach(grp => {
            let timestamp = grp.date;
            let existingTimestamp = Array.from(dataByDate.keys()).find(t => Math.abs(t - timestamp) <= 60);
            let targetKey = existingTimestamp || timestamp;

            if (!dataByDate.has(targetKey)) dataByDate.set(targetKey, { date: targetKey });
            let entry = dataByDate.get(targetKey);

            grp.measures.forEach(measure => {
                let val = measure.value * Math.pow(10, measure.unit);
                let metricName = config.metrics[measure.type];
                
                if (metricName) {
                    if (metricName === "Body Fat (%)") val = val + 3;
                    
                    if (metricName === "AFib Status") {
                        if (val === 9) val = "Sinus Rhythm (No Signs of AFib)";
                        else if (val === 10) val = "High Heart Rate (No Signs of AFib)";
                        else if (val === 5) val = "Poor Recording";
                        else val = `Unclassified (${val})`;
                    }

                    if (entry[metricName] === undefined) entry[metricName] = val;
                    // Use user.height here
                    if (metricName === "Weight (kg)" && user.height) {
                        entry["BMI"] = val / (user.height * user.height);
                    }
                }
            });
        });
    }
    return Array.from(dataByDate.values()).sort((a, b) => b.date - a.date);
}

function formatRow(item) {
    let d = new Date(item.date * 1000);
    let dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
    const getVal = (key, decimals = null) => {
        let val = item[key];
        if (val === undefined || val === null || val === "") return "";
        if (typeof val === 'number' && decimals !== null) return val.toFixed(decimals);
        return val;
    };

    return [
        dateStr,
        getVal("Weight (kg)", 2),
        getVal("BMI", 1),
        getVal("Body Fat (%)", 2),
        getVal("Visceral Fat Rating", 1),
        getVal("Pulse Wave Velocity (m/s)", 2),
        getVal("AFib Status"),
        getVal("Vascular Age (years)", 1),
        getVal("Nerve Health Score", 1)
    ].join(",");
}

function finalValidator(allRowsMap) {
    let approvedRows = [];
    let rejectedCount = 0;

    let sortedDates = Array.from(allRowsMap.keys()).sort((a, b) => new Date(b) - new Date(a));

    sortedDates.forEach(dateKey => {
        let row = allRowsMap.get(dateKey);
        let columns = row.split(',');
        let weightValue = columns[1] ? columns[1].trim() : "";

        if (weightValue !== "" && !isNaN(parseFloat(weightValue))) {
            approvedRows.push(row);
        } else {
            rejectedCount++;
        }
    });

    if (rejectedCount > 0) {
        console.log(`[Validation] Nuclear Scrub completed. Removed ${rejectedCount} rows.`);
    }
    return approvedRows;
}

// [UPDATED] Accepts user object to get driveFileName
async function writeCSVToDrive(mergedData, user) {
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    const headerRow = "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score";
    let fileId = null, fileContent = "";

    try {
        // Search for the specific user's file
        const listRes = await drive.files.list({ q: `'${config.driveFolderId}' in parents and name = '${user.driveFileName}' and trashed = false` });
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'text' });
            fileContent = getRes.data;
        } else {
            console.log(`File '${user.driveFileName}' not found. Creating new one.`);
        }

        let allRowsMap = new Map();
        
        if (fileContent && typeof fileContent === 'string') {
            fileContent.split(/\r?\n/).forEach(line => {
                let trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("date,")) {
                    allRowsMap.set(trimmed.split(',')[0], trimmed);
                }
            });
        }

        mergedData.forEach(item => {
            let row = formatRow(item);
            allRowsMap.set(row.split(',')[0], row);
        });

        let scrubbedRows = finalValidator(allRowsMap);

        let fullCSV = headerRow + "\n" + scrubbedRows.join("\n") + "\n";

        if (fileId) {
            await drive.files.update({ fileId, media: { mimeType: 'text/csv', body: fullCSV } });
            console.log(`Successfully updated Drive CSV for ${user.id}.`);
        } else {
            await drive.files.create({ requestBody: { name: user.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: fullCSV } });
            console.log(`Successfully created new Drive CSV for ${user.id}.`);
        }
    } catch (error) { console.log("Drive Error:", error.message); }
}

async function persistData(mergedData, user) {
    await writeCSVToDrive(mergedData, user);
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, processData, persistData };
