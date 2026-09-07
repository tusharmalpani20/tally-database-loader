export interface connectionConfig {
    technology: string;
    server: string;
    port: number;
    schema: string;
    ssl: boolean;
    username: string;
    password: string;
    loadmethod: string;
}

export interface tallyConfig {
    definition: string;
    server: string;
    port: number;
    fromdate: string; // [ YYYYMMDD / auto ]
    todate: string; // [ YYYYMMDD / auto ]
    sync: string; // [ full / incremental ]
    batchsize: number;
    frequency: number; // in minutes
    company: string;
}

export interface queryResult {
    rowCount: number;
    data: any[];
}

export interface collectionConfigJSON {
    collection: string; // name of collection as per Tally
    fetch?: string[]; // fetch list of fields which are not loaded by default
    compute?: computeFieldConfig[]; // list of computed fields
    filters?: filterConfigJson[];
    by?: string[]; // list of fields to group by
    aggrcompute?: string[]; // list of aggregate computations (SUM, COUNT, AVG, MIN, MAX)
}

export interface filterConfigJson {
    name: string; // name of the filter
    expression?: string; // filter expression (if not pre-defined)
}

export interface computeFieldConfig {
    name: string; // name of the computed field
    expression: string; // expression to compute the field value
}

export interface tableConfigJSON {
    name: string; // table name for database / CSV mapping
    isMaster: boolean; // is master table
    collectionPaths: string[]; // list of collection / sub-collection hierarchy paths
    fields: fieldConfigJSON[]; // list of fields
    filter?: tableFilterJson;
}

export interface tableFilterJson {
    field: string;
    operator: string; // [ == != < > <= >= ]
    value: string | number | boolean;
}

export interface fieldConfigJSON {
    name: string; // name as per database
    datatype: string; // data type as per database
    source: string; // source field name as per Tally
    transform?: transformFieldConfig; // transformation config (if any)
}

export interface transformFieldConfig {
    replace?: string | transformOperationReplace;
    concat?: string;
    lookup?: transformOperationLookup;
}

export interface transformOperationReplace {
    source: string;
    target: string;
}

export interface transformOperationLookup {
    sourceField: string;
    lookupCollection: string;
    lookupField: string
    returnField: string;
}

export interface fieldConfigYAML {
    name: string;
    field: string;
    type: string;
}

export interface tableFieldYAML {
    table: string;
    field: string;
}

export interface tableConfigYAML {
    voucher_identities?: boolean;
    order_details?: boolean;
    name: string;
    collection: string;
    nature: string;
    fields: fieldConfigYAML[];
    filters?: string[];
    /**
     * Filter set used for the incremental _diff request instead of `filters`. The diff only needs
     * guid and alterid to spot deleted and modified rows, so it may use a looser (superset) filter
     * when the full set is expensive for Tally to evaluate. A superset can only delete fewer rows,
     * never more. The trade-off is that a row which drops out of `filters` but stays in
     * `diff_filters` is not detected as deleted, so keep filters that govern deletion here.
     */
    diff_filters?: string[];
    fetch?: string[];
    subcollections?: tableConfigYAML[];
    cascade_update?: tableFieldYAML[];
    cascade_delete?: tableFieldYAML[];
}

export interface databaseFieldInfo {
    fieldName: string;
    dataType: string;
    isNullable: boolean;
    length?: number;
    precision?: number;
    scale?: number;
}

export interface tdlDefinitionItem {
    metadata: {
        name: string;
        type: string;
    },
    attributes: any[];
}

export interface tdlMessageItem {
    definitions: tdlDefinitionItem[];
}

export interface tdlStaticVariableItem {
    name: string;
    value: string;
}

export interface tdlRequestPayload {
    static_variables: tdlStaticVariableItem[];
    tdlmessage: tdlMessageItem[];
}

export interface companyInfo {
    name: string;
    booksfrom: Date;
    iscompanyactive: boolean;
    altmstid: number;
    altvchid?: number;
}
