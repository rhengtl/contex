"""
Everything outside this process.

    llm/        the model providers, and whether one is usable right now
    firebase    starting the Admin SDK
    accounts    creating accounts and proving who someone is

The rule these exist to enforce: nothing above this layer constructs an API
request by hand. Swapping a vendor should be a change inside one of these
modules, not a search across the application.
"""
