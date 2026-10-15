// The application's data model: the single authority for what the store holds (see src/flow.js).
// Change it here; a destructive change (removing a collection or a field) is refused when the app starts.
// Releases are keyed by "<name>@<version>" and immutable (src/store.js publishes with putIfAbsent).
flow_version 1

app Releases {
  collection Release {
    name: text
    version: text
    artifactId: text
    mediaType: text
    size: integer
    publishedAt: datetime
    release: json
    content: text
    index name using hash(name)
  }
}
