---
name: inkbox-contact-lookup
description: Resolve an Inkbox contact before using a name as a destination.
---

**Resolve names without changing the address book.**

- Literal address or phone number: use it as supplied when it is unambiguous. For “who owns this address?”, use `inkbox_lookup_contact` with `email` or `phone`. Use E.164 numbers including the country code.
- Person or company name: use `inkbox_list_contacts` with `q`. For a domain use the `emailDomain` lookup filter; a substring match is a candidate, not proof of identity.
- Fetch the chosen record with `inkbox_get_contact` and its `contactId`. If several contacts or destinations match, show the relevant labels and ask which one. A matching address does not imply permission to switch channels.

When asked to save a person, check for an existing match before `inkbox_create_contact`. Update the matching record rather than creating duplicates. Supply only the fields the user wants changed; check the existing list before replacing phone or email entries. Contacts are shared across the organization.
