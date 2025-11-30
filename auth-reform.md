My website currently uses firebase authentication via email - however, there is no way for users to manage their own account and I have to constantly reset/share new credentials with them.
I would like to instead enable sign-in to the GM portal through Google and Apple - but before the user can actually see any of the GM content, they must first enter a one-time activation code
provided by me. This should not only enable them to see the GM portal's contents but link them to their particular team to manage. I should still be able to manage users' connection to their team,
in case someone's access needs to be changed or revoked. This should also be grandfathered in (i.e., compatible with the existing auth framework). Is this possible and if so how can it be accomplished?
