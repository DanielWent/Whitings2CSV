var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

function getPreviousTimestamp() {
    try {
        let timestamp = fs.readFileSync(config.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) { return 1577836800; }
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
        }
    } catch (error) { console.log("Token Refresh Error:", error.message); }
}

function storeTokens(accessToken, refreshToken) {
    try { fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken })); } catch (error) { console.log("Error storing tokens", error); }
}

function storeTime(latestTimestamp) {
    try { fs.writeFileSync(config.timestamp_path, JSON.stringify(latestTimestamp)); } catch (error) { console.log("Error storing timestamp", error) }
}

async function processData(scaleData) {
    console.log("--- START DATA DEBUGGER ---");
    let simplifiedData = [];
    if (scaleData.measuregrps) {
        scaleData.measuregrps.forEach((grp, index) => {
            // Log every ID found in this specific measurement group
            const idsFound = grp.measures.map(m => m.type);
            console.log(`Group ${index} [Date: ${grp.date}]: Found Metric IDs: ${idsFound.join(', ')}`);
            
            grp.measures.forEach(measure => {
                let singleEntry = { date: grp.date };
                let metricName = config.metrics[measure.type];
                
                if (metricName) {
                    // Apply power-of-10 scaling: value * 10^unit
                    let val = measure.value * Math.pow(10, measure.unit);
                    singleEntry[metricName] = val;
                    simplifiedData.push(singleEntry);
                    
                    // Specific log for the "blank" metrics
                    if ([130, 135, 136, 137, 138].includes(measure.type)) {
                        console.log(` >> DEBUG ECG DATA: Type ${measure.type} (${metricName}) = Raw: ${measure.value}, Scaled: ${val}`);
                    }
                }
            });
        });
    }
    console.log("--- END DATA DEBUGGER ---");

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
    
    const headerRow = "date,Weight,Body Fat %,Heart Pulse,PWV (m/s),ECG Result,QRS (ms),PR (ms),QT (ms),QTc (ms),Vascular Age,Nerve Health\n";
    let fileId = null;
    let fileContent = "";

    try {
        const listRes = await drive.files.list({ q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`, fields: 'files(id, name)' });
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
        }

        const existingLines = (fileContent || "").split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        const dataLinesOnly = existingLines.filter(l => !l.startsWith("date"));
        const existingDates = dataLinesOnly.map(line => line.split(',')[0]);

        let newRowsList = [];
        for (var k = 0; k < mergedData.length; k++) {
            if (!existingDates.includes(mergedData[k].date)) {
                let row = `${mergedData[k].date},${mergedData[k]["Weight"]||""},${mergedData[k]["Body Fat %"]||""},${mergedData[k]["Heart Pulse"]||""},${mergedData[k]["PWV (m/s)"]||""},${mergedData[k]["ECG Result"]||""},${mergedData[k]["QRS (ms)"]||""},${mergedData[k]["PR (ms)"]||""},${mergedData[k]["QT (ms)"]||""},${mergedData[k]["QTc (ms)"]||""},${mergedData[k]["Vascular Age"]||""},${mergedData[k]["Nerve Health"]||""}`;
                newRowsList.push(row);
            }
        }

        if (newRowsList.length > 0) {
            const updatedBody = headerRow + newRowsList.join('\n') + '\n' + dataLinesOnly.join('\n');
            if (fileId) await drive.files.update({ fileId, media: { mimeType: 'text/csv', body: updatedBody } });
            else await drive.files.create({ resource: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: updatedBody } });
        }
    } catch (e) { console.log("Drive Sync Error:", e.message); }
}

async function persistData(mergedData) {
    for (var i = 0; i < mergedData.length; i++) {
        if (mergedData[i]["Weight"]) mergedData[i]["Weight"] = mergedData[i]["Weight"].toFixed(2);
        
        if (mergedData[i]["Body Fat %"]) {
            let bf = mergedData[i]["Body Fat %"] + 4;
            mergedData[i]["Body Fat %"] = bf.toFixed(2);
        }
        
        if (mergedData[i]["PWV (m/s)"]) mergedData[i]["PWV (m/s)"] = mergedData[i]["PWV (m/s)"].toFixed(2);
        if (mergedData[i]["Nerve Health"]) mergedData[i]["Nerve Health"] = mergedData[i]["Nerve Health"].toFixed(1);
        if (mergedData[i]["Vascular Age"]) mergedData[i]["Vascular Age"] = mergedData[i]["Vascular Age"].toFixed(1);

        // ECG Result Mapping
        if (mergedData[i]["ECG Result"] !== undefined) {
            const res = mergedData[i]["ECG Result"];
            if ([0, 1, 5, 10].includes(res)) mergedData[i]["ECG Result"] = "Normal (High HR)";
            else if ([2, 4].includes(res)) mergedData[i]["ECG Result"] = "AFib Detected";
            else if (res === 9) mergedData[i]["ECG Result"] = "Inconclusive (HR Low)";
            else mergedData[i]["ECG Result"] = `Normal (${res})`;
        }

        // Millisecond intervals
        ["QRS (ms)", "PR (ms)", "QT (ms)", "QTc (ms)"].forEach(key => {
            if (mergedData[i][key]) {
                 if (mergedData[i][key] < 2) mergedData[i][key] = (mergedData[i][key] * 1000).toFixed(0);
                 else mergedData[i][key] = mergedData[i][key].toFixed(0);
            }
        });

        let d = new Date(mergedData[i].date * 1000);
        let month = d.getMonth() + 1;
        mergedData[i].date = `${d.getFullYear()}-${("0"+month).slice(-2)}-${("0"+d.getDate()).slice(-2)} ${("0"+d.getHours()).slice(-2)}:${("0"+d.getMinutes()).slice(-2)}:${("0"+d.getSeconds()).slice(-2)}`;
    }
    await writeCSVToDrive(mergedData);
}

async function getWithingsData(accessToken, refreshToken, currentTime) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    bodyFormData.append('meastypes', config.metricList);
    bodyFormData.append('startdate', getPreviousTimestamp());
    bodyFormData.append('enddate', currentTime);
    try {
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders(), Authorization: 'Bearer ' + accessToken } });
        if (response.data.status == 0) {
            var mergedData = await processData(response.data.body);
            await persistData(mergedData);
            await storeTime(currentTime);
        } else if (response.data.status == 401) { await getReplacementAccessToken(refreshToken); }
    } catch (error) { console.log("Withings API Fetch Error:", error.message); }
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, persistData, processData };
