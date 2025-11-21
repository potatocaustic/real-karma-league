I need your help writing a script to seed my minor_v2_players collection in firestore. Here is the source data, a google sheet publihsed in csv format: https://docs.google.com/spreadsheets/d/e/2PACX-1vR2E--N7B6cD-_HWaIpxIObmDVuIxqgXhfHkf6vE1FGHeAccozSl416DtQF-lGeWUhiF_Bm-geu9yMU/pub?output=csv
1. The sheet columns, from left to right, are: player_handle, player_id, current_team_id. Row 1 is column headers. 
2. minor_v2_players should be structured exactly like v2_players, the major league players collection. Each player's doc ID should be their player_id. 
3. In the root level of each player's minor_v2_players doc, there should be the following fields: current_team_id, player_handle, player_id, and player_status. (Note: player_status should be set to "ACTIVE" for all players being written to firestore here)
4. Within each player's doc, there should be a seasonal_stats subcollection. The first document's ID should be S9.
5. At minor_v2_players/{player_id}/seasonal_stats/S9/ there should be created every field that is found in a major league team doc at v2_players/{player_id}/seasonal_stats/S9/.
6. The script should be fully reversable - i.e., if something goes wrong I can quickly and cleanly revert all the changes made by the script.
