I would like to  add a secondary "game flow" chart view in the game detail modals that appear in /S9/RKL-S9.html, /S9/schedule.html, /S9/player.html, and /S9/team.html. 
1. Chart Type & Data Representation
Current: Line chart showing cumulative scores for both teams (both lines climbing from 0 to final scores)
New: Area/flow chart showing point differential/lead margin (which team is ahead and by how much at each moment)
2. Y-Axis
Current: Absolute score values (ex: 0 to 45,000+)
New: Relative lead/deficit - appears to show the margin between teams, with a center line at 0 representing a tied game
3. Visual Style
Current: Two separate line graphs that can be compared
New: Single flowing area chart that fills above/below a centerline, with the filled area indicating which team has the lead
4. Header/Title
Current: Team names and date in title format ("Otters vs Piggies - 11/17/25")
New: Score display with team icons, date shown separately in corner (124-122 with icons, "Nov 16, 2025")
5. Legend & Labels
Current: Explicit legend showing team names
New: No visible legend - teams distinguished by position (above/below center) and team colors derived from team logos
6. Grid & Aesthetics
Current: Visible grid lines for reference
New: Minimal/no grid lines, cleaner appearance with focus on the flow
IMPORTANT NOTES: 
1. This should not replace the current gameflow view. Rather, when a user has toggled to gameflow, there should be a button on the charts allowing them to toggle *between the two different styles of gameflow charts*.
2. I would also like both gameflow views to display the number of lead changes that have taken place in the game and each team's biggest recorded lead during that game. 
3. Margins/differentials and number of lead changes are not currently calculated by the relevant cloud function(s). Please edit them to correctly record this data throughout each game, *and* write a script that I can run from the admin portal to retroactively write this data to existing/previous games' data in the game_flow_snapshots firestore collection.
