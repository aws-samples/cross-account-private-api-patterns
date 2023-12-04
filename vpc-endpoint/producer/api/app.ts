export interface GetWidgetEvent {
}

export const lambdaHandler = async (event: GetWidgetEvent) => {
    return {
        statusCode: 200,
        body: JSON.stringify({
            "id": "1",
            "value": "4.99"
        }),
    };
};
