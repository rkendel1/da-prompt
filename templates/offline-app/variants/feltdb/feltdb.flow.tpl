// The application's data model: the single authority for what the store holds (see src/flow.js).
// Change it here; a destructive change (removing a collection or a field) is refused when the app starts.
flow_version 1

app Tracker {
  collection Item {
    title: text
    notes: text
    done: boolean
    createdAt: datetime
    updatedAt: datetime
  }
}
