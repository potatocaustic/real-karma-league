I need your help writing a script to seed my minor_v2_teams collection in firestore. Here is the source data, a google sheet publichsed in csv format: https://docs.google.com/spreadsheets/d/e/2PACX-1vRzKZ3Bhr1kC5176yPZ6hLvIl2t_Y1-LbGxVliiGNxPa0jFqheH6kMp_HoVexd78mWUnx1k857lC3oj/pub?output=csv
1. The sheet columns, from left to right, are: team_name, team_id, conference, current_gm_handle, gm_player_id, gm_uid. Row 1 is column headers. The gm_uid column is blank for every team; a field with a blank or null value should be created for each team.
2. minor_v2_teams should be structured exactly like v2_teams, the major league teams collection. Each team's doc ID should be its team_id.
3. In the root level of each team's minor_v2_teams doc, there should be the following fields: conference, current_gm_handle, gm_player_id, gm_uid
4. Within each team's doc, there should be a seasonal_records subcollection. The first document's ID should be S9.
5. At minor_v2_teams/{team_id}/seasonal_records/S9/ there should be created every field that is found in a major league team doc at v2_teams/{team_id}/seasonal_records/S9/.
6. The script should be fully reversable - i.e., if something goes wrong I can quickly and cleanly revert all the changes made by the script.
