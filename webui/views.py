from django.shortcuts import render

def activity(request):
    return render(request, 'webui/activity.html', {})
